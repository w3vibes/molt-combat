import { BettingMarketRecord, MarketPayout, MarketPositionRecord } from '../types/domain.js';
import { verifyMatchAttestation } from './attestation.js';
import { isStrictSandboxMatch } from './fairness.js';
import { store } from './store.js';

export type MarketResolutionResult = {
  market: BettingMarketRecord;
  payouts: MarketPayout[];
  totalPool: string;
  feeAmount: string;
  payoutPool: string;
};

function toBigInt(amount: string): bigint {
  try {
    const parsed = BigInt(amount);
    if (parsed <= 0n) throw new Error('amount_must_be_positive');
    return parsed;
  } catch {
    throw new Error('invalid_amount');
  }
}

export function calculateMarketPayouts(params: {
  positions: MarketPositionRecord[];
  winningOutcome: string;
  feeBps: number;
}): {
  payouts: MarketPayout[];
  totalPool: string;
  feeAmount: string;
  payoutPool: string;
  winningPool: string;
} {
  const totalPool = params.positions.reduce((sum, position) => sum + BigInt(position.amount), 0n);
  const feeAmount = (totalPool * BigInt(params.feeBps)) / 10_000n;
  const payoutPool = totalPool - feeAmount;

  const winningPositions = params.positions.filter((position) => position.outcome === params.winningOutcome);
  const winningPool = winningPositions.reduce((sum, position) => sum + BigInt(position.amount), 0n);

  if (winningPool <= 0n || payoutPool <= 0n) {
    return {
      payouts: [],
      totalPool: totalPool.toString(),
      feeAmount: feeAmount.toString(),
      payoutPool: payoutPool.toString(),
      winningPool: winningPool.toString()
    };
  }

  const byBettor = new Map<string, bigint>();
  for (const position of winningPositions) {
    const amount = BigInt(position.amount);
    byBettor.set(position.bettor, (byBettor.get(position.bettor) ?? 0n) + amount);
  }

  const payouts = [...byBettor.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([bettor, stake]) => ({
      bettor,
      stake,
      amount: (payoutPool * stake) / winningPool
    }));

  let distributed = payouts.reduce((sum, payout) => sum + payout.amount, 0n);
  const remainder = payoutPool - distributed;
  if (remainder > 0n && payouts.length > 0) {
    payouts[0].amount += remainder;
    distributed += remainder;
  }

  return {
    payouts: payouts.map((payout) => ({ bettor: payout.bettor, amount: payout.amount.toString() })),
    totalPool: totalPool.toString(),
    feeAmount: feeAmount.toString(),
    payoutPool: distributed.toString(),
    winningPool: winningPool.toString()
  };
}

export function assertMarketBetInput(params: { outcome: string; amount: string }) {
  if (!params.outcome.trim()) throw new Error('missing_outcome');
  toBigInt(params.amount);
}

export function resolveMarketByOutcome(params: { marketId: string; winningOutcome: string }): MarketResolutionResult {
  const market = store.getMarket(params.marketId);
  if (!market) throw new Error('market_not_found');
  if (!market.outcomes.includes(params.winningOutcome)) throw new Error('invalid_outcome');

  let mutableMarket = market;
  if (mutableMarket.status === 'open') {
    const locked = store.lockMarket(mutableMarket.id);
    if (!locked) throw new Error('market_not_found');
    mutableMarket = locked;
  }

  if (mutableMarket.status !== 'locked') throw new Error('market_not_lockable');

  const positions = store.listMarketPositions(mutableMarket.id);
  const calculation = calculateMarketPayouts({
    positions,
    winningOutcome: params.winningOutcome,
    feeBps: mutableMarket.feeBps
  });

  const resolved = store.resolveMarket(mutableMarket.id, {
    resultOutcome: params.winningOutcome,
    payouts: calculation.payouts,
    totalPool: calculation.totalPool,
    feeAmount: calculation.feeAmount,
    payoutPool: calculation.payoutPool
  });

  if (!resolved) throw new Error('market_not_found');

  return {
    market: resolved,
    payouts: calculation.payouts,
    totalPool: calculation.totalPool,
    feeAmount: calculation.feeAmount,
    payoutPool: calculation.payoutPool
  };
}

function isStrictAttestedMatch(matchId: string): { ok: boolean; reason?: string } {
  const match = store.getMatch(matchId);
  if (!match) return { ok: false, reason: 'match_not_found' };
  if (!isStrictSandboxMatch(match)) return { ok: false, reason: 'strict_sandbox_unverified' };

  const attestation = store.getMatchAttestation(matchId);
  if (!attestation) return { ok: false, reason: 'attestation_not_found' };

  const verification = verifyMatchAttestation(attestation, match);
  if (!verification.valid) return { ok: false, reason: verification.reason || 'attestation_invalid' };

  return { ok: true };
}

export function autoResolveMarketsForMatch(params: {
  matchId: string;
  winnerAgentId?: string;
  challengeId?: string;
}): {
  checked: number;
  resolved: number;
  skipped: Array<{ marketId: string; reason: string }>;
} {
  if (!params.winnerAgentId) {
    return { checked: 0, resolved: 0, skipped: [] };
  }

  const targets = [
    ...store.listMarkets({ subjectType: 'match', subjectId: params.matchId }).filter((market) => market.status === 'open' || market.status === 'locked'),
    ...(params.challengeId
      ? store.listMarkets({ subjectType: 'challenge', subjectId: params.challengeId }).filter((market) => market.status === 'open' || market.status === 'locked')
      : [])
  ];

  const strictCheck = isStrictAttestedMatch(params.matchId);

  const skipped: Array<{ marketId: string; reason: string }> = [];
  let resolved = 0;

  for (const market of targets) {
    if (!strictCheck.ok) {
      skipped.push({ marketId: market.id, reason: strictCheck.reason || 'strict_match_required' });
      continue;
    }

    if (!market.outcomes.includes(params.winnerAgentId)) {
      skipped.push({ marketId: market.id, reason: 'winner_not_in_outcomes' });
      continue;
    }

    try {
      resolveMarketByOutcome({ marketId: market.id, winningOutcome: params.winnerAgentId });
      resolved += 1;
    } catch (error) {
      skipped.push({
        marketId: market.id,
        reason: error instanceof Error ? error.message : 'market_resolve_error'
      });
    }
  }

  return {
    checked: targets.length,
    resolved,
    skipped
  };
}
