import { describe, expect, it } from 'vitest';
import { evaluateHeadToHeadCollusionRisk } from './collusion.js';
import type { MatchRecord } from '../types/domain.js';

function sampleMatch(params: {
  id: string;
  a: string;
  b: string;
  winner?: string;
  startedAt: string;
}): MatchRecord {
  return {
    id: params.id,
    status: 'finished',
    startedAt: params.startedAt,
    turnsPlayed: 1,
    winner: params.winner,
    agents: [
      { id: params.a, name: params.a, endpoint: `https://${params.a}.example.com` },
      { id: params.b, name: params.b, endpoint: `https://${params.b}.example.com` }
    ],
    replay: [],
    config: { maxTurns: 1, seed: 1, attackCost: 1, attackDamage: 1 }
  };
}

describe('collusion risk checks', () => {
  it('passes for low-frequency head-to-head history', () => {
    const now = new Date();
    const matches = [
      sampleMatch({ id: 'm1', a: 'a1', b: 'a2', winner: 'a1', startedAt: now.toISOString() }),
      sampleMatch({ id: 'm2', a: 'a1', b: 'a2', winner: 'a2', startedAt: now.toISOString() })
    ];

    const result = evaluateHeadToHeadCollusionRisk({
      agentAId: 'a1',
      agentBId: 'a2',
      matches,
      required: true
    });

    expect(result.passed).toBe(true);
    expect(result.reasons.length).toBe(0);
  });

  it('flags dominant outcomes in repeated head-to-head matches', () => {
    const now = Date.now();
    const matches = Array.from({ length: 7 }, (_, idx) => sampleMatch({
      id: `m${idx}`,
      a: 'a1',
      b: 'a2',
      winner: 'a1',
      startedAt: new Date(now - idx * 60_000).toISOString()
    }));

    const result = evaluateHeadToHeadCollusionRisk({
      agentAId: 'a1',
      agentBId: 'a2',
      matches,
      required: true
    });

    expect(result.passed).toBe(false);
    expect(result.reasons.some((reason) => reason.startsWith('dominant_outcomes:'))).toBe(true);
  });
});
