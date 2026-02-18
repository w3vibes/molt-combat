import { ChallengeRecord } from '../types/domain.js';
import { toMatchIdHex } from '../utils/ids.js';
import { getEscrowMatchStatus, settleEscrowMatch } from './escrow.js';
import { store } from './store.js';

export type EscrowAutomationAction = {
  challengeId: string;
  matchId: string;
  action: 'settled' | 'pending_deposits' | 'already_settled' | 'skipped' | 'error';
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
  if (challenge.stake.mode !== 'usdc') return null;

  const playerA = challenge.stake.playerA;
  const playerB = challenge.stake.playerB;
  if (!playerA || !playerB || !challenge.winnerAgentId) return null;

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

  return null;
}

function settlementCandidates(): ChallengeRecord[] {
  return store
    .listChallenges('completed')
    .filter(
      (challenge) =>
        challenge.stake.mode === 'usdc' &&
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
        if (!challenge.matchId) continue;
        actions.push({
          challengeId: challenge.id,
          matchId: challenge.matchId,
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
        automationType: 'escrow_settlement',
        status: 'ok',
        startedAt,
        finishedAt: summary.finishedAt,
        summary
      });

      lastTick = summary;
      return summary;
    }

    for (const challenge of candidates) {
      if (!challenge.matchId || challenge.stake.mode !== 'usdc') continue;
      const contractAddress = challenge.stake.contractAddress;

      if (!contractAddress) {
        actions.push({
          challengeId: challenge.id,
          matchId: challenge.matchId,
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
          action: 'error',
          reason: 'winner_wallet_unresolved'
        });
        errors += 1;
        continue;
      }

      try {
        const status = await getEscrowMatchStatus({
          rpcUrl: chainRpc,
          contractAddress,
          matchIdHex: toMatchIdHex(challenge.matchId)
        });

        if (status.settled) {
          actions.push({
            challengeId: challenge.id,
            matchId: challenge.matchId,
            action: 'already_settled'
          });
          continue;
        }

        if (!status.playerADeposited || !status.playerBDeposited) {
          actions.push({
            challengeId: challenge.id,
            matchId: challenge.matchId,
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
          action: 'settled',
          txHash
        });

        store.patchChallenge(challenge.id, {
          notes: appendNote(
            challenge.notes,
            `automation_settled:${new Date().toISOString()}:${txHash || 'tx_unknown'}`
          )
        });
      } catch (error) {
        errors += 1;
        actions.push({
          challengeId: challenge.id,
          matchId: challenge.matchId,
          action: 'error',
          reason: error instanceof Error ? error.message : 'escrow_automation_error'
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
      automationType: 'escrow_settlement',
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
    recentRuns: store.listAutomationRuns('escrow_settlement', 10)
  };
}
