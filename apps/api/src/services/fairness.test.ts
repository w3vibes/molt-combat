import { describe, expect, it } from 'vitest';
import { checkSandboxParity } from './fairness.js';
import type { RegisteredAgent } from './store.js';

function agent(id: string, sandbox?: Record<string, unknown>): RegisteredAgent {
  return {
    id,
    name: id,
    endpoint: `https://${id}.example.com`,
    enabled: true,
    metadata: sandbox ? { sandbox } : {},
    lastHealthStatus: 'unknown',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
}

describe('sandbox parity', () => {
  it('passes when sandbox profiles are symmetric', () => {
    const result = checkSandboxParity([
      agent('a1', { runtime: 'node', version: '20.11', cpu: 2, memory: 2048 }),
      agent('a2', { runtime: 'node', version: '20.11', cpu: 2, memory: 2048 })
    ], true);

    expect(result.passed).toBe(true);
    expect(result.reason).toBeUndefined();
  });

  it('fails when sandbox profiles mismatch', () => {
    const result = checkSandboxParity([
      agent('a1', { runtime: 'node', version: '20.11', cpu: 2, memory: 2048 }),
      agent('a2', { runtime: 'node', version: '20.11', cpu: 4, memory: 2048 })
    ], true);

    expect(result.passed).toBe(false);
    expect(result.reason).toContain('sandbox_profile_mismatch');
    expect(result.mismatchedFields).toContain('cpu');
  });

  it('fails when required and profile metadata is missing', () => {
    const result = checkSandboxParity([agent('a1'), agent('a2')], true);

    expect(result.passed).toBe(false);
    expect(result.reason).toBe('missing_sandbox_profiles');
  });
});
