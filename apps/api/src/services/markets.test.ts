import { describe, expect, it } from 'vitest';
import { calculateMarketPayouts } from './markets.js';
import { MarketPositionRecord } from '../types/domain.js';

function position(input: Partial<MarketPositionRecord> & Pick<MarketPositionRecord, 'id'>): MarketPositionRecord {
  return {
    id: input.id,
    marketId: input.marketId ?? 'market_1',
    bettor: input.bettor ?? 'bettor',
    outcome: input.outcome ?? 'A',
    amount: input.amount ?? '1',
    createdAt: input.createdAt ?? new Date().toISOString()
  };
}

describe('market payout calculation', () => {
  it('pays the full net pool to the winning side', () => {
    const positions = [
      position({ id: 'p1', bettor: 'alice', outcome: 'A', amount: '60' }),
      position({ id: 'p2', bettor: 'bob', outcome: 'B', amount: '40' })
    ];

    const result = calculateMarketPayouts({
      positions,
      winningOutcome: 'A',
      feeBps: 100
    });

    expect(result.totalPool).toBe('100');
    expect(result.feeAmount).toBe('1');
    expect(result.payoutPool).toBe('99');
    expect(result.payouts).toEqual([{ bettor: 'alice', amount: '99' }]);
  });

  it('distributes proportionally with deterministic rounding remainder', () => {
    const positions = [
      position({ id: 'p1', bettor: 'alice', outcome: 'A', amount: '1' }),
      position({ id: 'p2', bettor: 'bob', outcome: 'A', amount: '2' }),
      position({ id: 'p3', bettor: 'carol', outcome: 'B', amount: '97' })
    ];

    const result = calculateMarketPayouts({
      positions,
      winningOutcome: 'A',
      feeBps: 0
    });

    expect(result.totalPool).toBe('100');
    expect(result.payoutPool).toBe('100');
    expect(result.payouts).toEqual([
      { bettor: 'alice', amount: '34' },
      { bettor: 'bob', amount: '66' }
    ]);
  });
});
