import { ChallengeRecord } from '../types/domain.js';
import { toMatchIdHex } from '../utils/ids.js';
import { getEscrowMatchStatus, settleEscrowMatch } from './escrow.js';
import { getPrizePoolMatchStatus, payoutOnSepolia } from './payout.js';
import { store } from './store.js';

export type EscrowAutomationAction = {
  challengeId: string;
  matchId: string;
  mode: 'usdc' | 'eth';
  action: 'settled' | 'pending_deposits' | 'pending_funding' | 'already_settled' | 'skipped' | 'error';
  reason?: string;
  txHash?: string;
};

export type EscrowAutomationTickSummary = {
  startedAt: string;
  finishedAt: string;
  source: string;
  checked: number;
  settled: number;
  errors: number;
  actions: EscrowAutomationAction[];
};

let pollingTimer: NodeJS.Timeout | null = null;
let inFlightTick: Promise<EscrowAutomationTickSummary> | null = null;
let lastTick: EscrowAutomationTickSummary | null = null;

function signerKey(): string | undefined {
  return (process.env.PAYOUT_SIGNER_PRIVATE_KEY || process.env.OPERATOR_PRIVATE_KEY)?.trim();
}

function rpcUrl(): string | undefined {
  return process.env.SEPOLIA_RPC_URL?.trim();
}

function pollingIntervalMs(): number {
  const raw = Number(process.env.AUTOMATION_ESCROW_INTERVAL_MS || 15000);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 15000;
}

function pollingEnabledByEnv(): boolean {
  return process.env.AUTOMATION_ESCROW_ENABLED !== 'false';
}

function appendNote(existing: string | undefined, note: string): string {
  return [existing, note].filter(Boolean).join('\n');
}

function toLower(value: string | undefined): string {
  return value?.toLowerCase() || '';
}

function winnerWallet(challenge: ChallengeRecord): string | null {
  if (!challenge.winnerAgentId) return null;

  if (challenge.stake.mode === 'usdc') {
    const playerA = challenge.stake.playerA;
    const playerB = challenge.stake.playerB;

    if (playerA && playerB) {
      const winnerAgent = store.getAgent(challenge.winnerAgentId);
      const winnerAddress = winnerAgent?.payoutAddress;

      if (winnerAddress) {
        const lowered = toLower(winnerAddress);
        if (lowered === toLower(playerA) || lowered === toLower(playerB)) {
          return winnerAddress;
        }
      }

      if (challenge.winnerAgentId === challenge.challengerAgentId) return playerA;
      if (challenge.winnerAgentId === challenge.opponentAgentId) return playerB;
    }
  }

  const winnerAgent = store.getAgent(challenge.winnerAgentId);
  return winnerAgent?.payoutAddress || null;
}

function settlementCandidates(): ChallengeRecord[] {
  return store
    .listChallenges('completed')
    .filter(
      (challenge) =>
        (challenge.stake.mode === 'usdc' || challenge.stake.mode === 'eth') &&
        Boolean(challenge.matchId) &&
        Boolean(challenge.winnerAgentId)
    );
}

export async function runEscrowSettlementTick(source = 'manual'): Promise<EscrowAutomationTickSummary> {
  if (inFlightTick) return inFlightTick;

  inFlightTick = (async () => {
    const startedAt = new Date().toISOString();
    const actions: EscrowAutomationAction[] = [];
    let settled = 0;
    let errors = 0;

    const candidates = settlementCandidates();
    const chainRpc = rpcUrl();
    const key = signerKey();

    if (!chainRpc || !key) {
      for (const challenge of candidates) {
        if (!challenge.matchId || (challenge.stake.mode !== 'usdc' && challenge.stake.mode !== 'eth')) continue;
        actions.push({
          challengeId: challenge.id,
          matchId: challenge.matchId,
          mode: challenge.stake.mode,
          action: 'skipped',
          reason: 'missing_chain_config'
        });
      }

      const summary: EscrowAutomationTickSummary = {
        startedAt,
        finishedAt: new Date().toISOString(),
        source,
        checked: candidates.length,
        settled,
        errors,
        actions
      };

      store.recordAutomationRun({
        automationType: 'payout_settlement',
        status: 'ok',
        startedAt,
        finishedAt: summary.finishedAt,
        summary
      });

      lastTick = summary;
      return summary;
    }

    for (const challenge of candidates) {
      if (!challenge.matchId || (challenge.stake.mode !== 'usdc' && challenge.stake.mode !== 'eth')) continue;
      const contractAddress = challenge.stake.contractAddress;

      if (!contractAddress) {
        actions.push({
          challengeId: challenge.id,
          matchId: challenge.matchId,
          mode: challenge.stake.mode,
          action: 'skipped',
          reason: 'missing_contract_address'
        });
        continue;
      }

      const winner = winnerWallet(challenge);
      if (!winner) {
        actions.push({
          challengeId: challenge.id,
          matchId: challenge.matchId,
          mode: challenge.stake.mode,
          action: 'error',
          reason: 'winner_wallet_unresolved'
        });
        errors += 1;
        continue;
      }

      try {
        if (challenge.stake.mode === 'usdc') {
          const status = await getEscrowMatchStatus({
            rpcUrl: chainRpc,
            contractAddress,
            matchIdHex: toMatchIdHex(challenge.matchId)
          });

          if (status.settled) {
            actions.push({
              challengeId: challenge.id,
              matchId: challenge.matchId,
              mode: 'usdc',
              action: 'already_settled'
            });
            continue;
          }

          if (!status.playerADeposited || !status.playerBDeposited) {
            actions.push({
              challengeId: challenge.id,
              matchId: challenge.matchId,
              mode: 'usdc',
              action: 'pending_deposits'
            });
            continue;
          }

          const receipt = await settleEscrowMatch({
            rpcUrl: chainRpc,
            privateKey: key,
            contractAddress,
            matchIdHex: toMatchIdHex(challenge.matchId),
            winner
          });

          settled += 1;
          const txHash = receipt?.hash ?? undefined;

          actions.push({
            challengeId: challenge.id,
            matchId: challenge.matchId,
            mode: 'usdc',
            action: 'settled',
            txHash
          });

          store.patchChallenge(challenge.id, {
            notes: appendNote(
              challenge.notes,
              `automation_settled_usdc:${new Date().toISOString()}:${txHash || 'tx_unknown'}`
            )
          });

          continue;
        }

        const status = await getPrizePoolMatchStatus({
          rpcUrl: chainRpc,
          contractAddress,
          matchIdHex: toMatchIdHex(challenge.matchId)
        });

        if (status.paid) {
          actions.push({
            challengeId: challenge.id,
            matchId: challenge.matchId,
            mode: 'eth',
            action: 'already_settled'
          });
          continue;
        }

        if (status.fundedAmountWei === '0') {
          actions.push({
            challengeId: challenge.id,
            matchId: challenge.matchId,
            mode: 'eth',
            action: 'pending_funding'
          });
          continue;
        }

        const receipt = await payoutOnSepolia({
          rpcUrl: chainRpc,
          privateKey: key,
          contractAddress,
          matchIdHex: toMatchIdHex(challenge.matchId),
          winner
        });

        settled += 1;
        const txHash = receipt?.hash ?? undefined;

        actions.push({
          challengeId: challenge.id,
          matchId: challenge.matchId,
          mode: 'eth',
          action: 'settled',
          txHash
        });

        store.patchChallenge(challenge.id, {
          notes: appendNote(
            challenge.notes,
            `automation_settled_eth:${new Date().toISOString()}:${txHash || 'tx_unknown'}`
          )
        });
      } catch (error) {
        errors += 1;
        actions.push({
          challengeId: challenge.id,
          matchId: challenge.matchId,
          mode: challenge.stake.mode,
          action: 'error',
          reason: error instanceof Error ? error.message : 'payout_automation_error'
        });
      }
    }

    const finishedAt = new Date().toISOString();
    const summary: EscrowAutomationTickSummary = {
      startedAt,
      finishedAt,
      source,
      checked: candidates.length,
      settled,
      errors,
      actions
    };

    store.recordAutomationRun({
      automationType: 'payout_settlement',
      status: errors > 0 ? 'error' : 'ok',
      startedAt,
      finishedAt,
      summary
    });

    lastTick = summary;
    return summary;
  })().finally(() => {
    inFlightTick = null;
  });

  return inFlightTick;
}

export function startEscrowSettlementPolling(): { started: boolean; intervalMs: number } {
  if (pollingTimer) {
    return { started: false, intervalMs: pollingIntervalMs() };
  }

  const intervalMs = pollingIntervalMs();
  pollingTimer = setInterval(() => {
    runEscrowSettlementTick('polling').catch(() => {
      // Keep polling loop alive even when a tick fails.
    });
  }, intervalMs);

  return { started: true, intervalMs };
}

export function stopEscrowSettlementPolling(): { stopped: boolean } {
  if (!pollingTimer) return { stopped: false };
  clearInterval(pollingTimer);
  pollingTimer = null;
  return { stopped: true };
}

export function maybeStartEscrowSettlementPolling(): { started: boolean; intervalMs: number } {
  if (!pollingEnabledByEnv()) {
    return { started: false, intervalMs: pollingIntervalMs() };
  }
  return startEscrowSettlementPolling();
}

export function escrowAutomationStatus() {
  return {
    pollingActive: Boolean(pollingTimer),
    intervalMs: pollingIntervalMs(),
    inFlight: Boolean(inFlightTick),
    envEnabled: pollingEnabledByEnv(),
    lastTick,
    recentRuns: [
      ...store.listAutomationRuns('payout_settlement', 10),
      ...store.listAutomationRuns('escrow_settlement', 10)
    ].sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt)).slice(0, 10)
  };
}
