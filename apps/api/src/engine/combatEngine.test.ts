import { describe, it, expect, vi } from 'vitest';
import { runMatch } from './combatEngine.js';

vi.stubGlobal(
  'fetch',
  vi.fn(async () => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify({ type: 'hold' })
  })) as any
);

describe('combat engine', () => {
  it('runs deterministic hold-only match', async () => {
    const match = await runMatch({
      id: 'm1',
      agents: [
        { id: 'a1', name: 'A', endpoint: 'https://a.test' },
        { id: 'a2', name: 'B', endpoint: 'https://b.test' }
      ],
      config: { maxTurns: 5, seed: 1, attackCost: 1, attackDamage: 3 }
    });
    expect(match.status).toBe('finished');
    expect(match.turnsPlayed).toBe(5);
    expect(match.scorecardHash).toBeTruthy();
    expect(match.replay[0]?.metering).toBeTruthy();
    expect(match.audit?.meteringTotals.requestBytes).toBeGreaterThan(0);
    expect(match.audit?.meteringTotals.fallbackHolds).toBe(0);
  });
});
