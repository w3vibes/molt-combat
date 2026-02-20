import { describe, expect, it } from 'vitest';
import {
  checkSandboxParity,
  evaluateStrictSandboxPolicy,
  checkEigenComputeParity
} from './fairness.js';
import type { RegisteredAgent } from './store.js';

function agent(params: {
  id: string;
  sandbox?: Record<string, unknown>;
  eigencompute?: Record<string, unknown>;
  endpoint?: string;
  metadata?: Record<string, unknown>;
}): RegisteredAgent {
  return {
    id: params.id,
    name: params.id,
    endpoint: params.endpoint ?? `https://${params.id}.example.com`,
    enabled: true,
    metadata: {
      ...(params.metadata || {}),
      ...(params.sandbox ? { sandbox: params.sandbox } : {}),
      ...(params.eigencompute ? { eigencompute: params.eigencompute } : {})
    },
    lastHealthStatus: 'unknown',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
}

describe('sandbox parity', () => {
  it('passes when sandbox profiles are symmetric', () => {
    const result = checkSandboxParity([
      agent({ id: 'a1', sandbox: { runtime: 'node', version: '20.11', cpu: 2, memory: 2048 } }),
      agent({ id: 'a2', sandbox: { runtime: 'node', version: '20.11', cpu: 2, memory: 2048 } })
    ], true);

    expect(result.passed).toBe(true);
    expect(result.reason).toBeUndefined();
  });

  it('fails when sandbox profiles mismatch', () => {
    const result = checkSandboxParity([
      agent({ id: 'a1', sandbox: { runtime: 'node', version: '20.11', cpu: 2, memory: 2048 } }),
      agent({ id: 'a2', sandbox: { runtime: 'node', version: '20.11', cpu: 4, memory: 2048 } })
    ], true);

    expect(result.passed).toBe(false);
    expect(result.reason).toContain('sandbox_profile_mismatch');
    expect(result.mismatchedFields).toContain('cpu');
  });

  it('fails when required and profile metadata is missing', () => {
    const result = checkSandboxParity([agent({ id: 'a1' }), agent({ id: 'a2' })], true);

    expect(result.passed).toBe(false);
    expect(result.reason).toBe('missing_sandbox_profiles');
  });
});

describe('eigencompute parity', () => {
  it('fails when required and eigencompute metadata missing', () => {
    const result = checkEigenComputeParity([
      agent({ id: 'a1' }),
      agent({ id: 'a2' })
    ], { required: true });

    expect(result.passed).toBe(false);
    expect(result.reason).toBe('missing_eigencompute_profiles');
  });

  it('passes with valid metadata', () => {
    const result = checkEigenComputeParity([
      agent({ id: 'a1', eigencompute: { appId: '0x1111111111111111111111111111111111111111', environment: 'sepolia', imageDigest: 'sha256:aaa', signerAddress: '0x1111111111111111111111111111111111111112' } }),
      agent({ id: 'a2', eigencompute: { appId: '0x2222222222222222222222222222222222222222', environment: 'sepolia', imageDigest: 'sha256:aaa', signerAddress: '0x2222222222222222222222222222222222222223' } })
    ], { required: true });

    expect(result.passed).toBe(true);
  });
});

describe('strict sandbox policy', () => {
  it('rejects simple mode when endpoint execution is required', () => {
    const result = evaluateStrictSandboxPolicy({
      agents: [
        agent({ id: 'a1', endpoint: 'https://agent.local/a1', sandbox: { runtime: 'node', version: '20.11', cpu: 2, memory: 2048 } }),
        agent({ id: 'a2', endpoint: 'https://agent.local/a2', sandbox: { runtime: 'node', version: '20.11', cpu: 2, memory: 2048 } })
      ],
      executionMode: 'simple',
      endpointModeRequired: true,
      requireParity: true,
      requireEigenCompute: false
    });

    expect(result.passed).toBe(false);
    expect(result.reason).toContain('agent_mode_not_endpoint');
    expect(result.strictVerified).toBe(false);
  });

  it('passes strict mode for endpoint execution with parity + eigencompute metadata', () => {
    const result = evaluateStrictSandboxPolicy({
      agents: [
        agent({
          id: 'a1',
          sandbox: { runtime: 'node', version: '20.11', cpu: 2, memory: 2048 },
          eigencompute: {
            appId: '0x1111111111111111111111111111111111111111',
            environment: 'sepolia',
            imageDigest: 'sha256:matchdigest',
            signerAddress: '0x1111111111111111111111111111111111111112'
          }
        }),
        agent({
          id: 'a2',
          sandbox: { runtime: 'node', version: '20.11', cpu: 2, memory: 2048 },
          eigencompute: {
            appId: '0x2222222222222222222222222222222222222222',
            environment: 'sepolia',
            imageDigest: 'sha256:matchdigest',
            signerAddress: '0x2222222222222222222222222222222222222223'
          }
        })
      ],
      executionMode: 'endpoint',
      endpointModeRequired: true,
      requireParity: true,
      requireEigenCompute: true
    });

    expect(result.passed).toBe(true);
    expect(result.strictVerified).toBe(true);
  });
});
