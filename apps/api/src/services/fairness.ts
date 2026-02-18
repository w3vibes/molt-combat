import type { SandboxProfile } from '../types/domain.js';
import type { RegisteredAgent } from './store.js';

export type SandboxParityResult = {
  required: boolean;
  enforced: boolean;
  passed: boolean;
  reason?: string;
  profiles: Record<string, SandboxProfile>;
  mismatchedFields?: Array<keyof SandboxProfile>;
};

export function sandboxParityRequiredByDefault(): boolean {
  return process.env.MATCH_REQUIRE_SANDBOX_PARITY !== 'false';
}

function parsePositiveNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value;
  if (typeof value === 'string' && value.trim()) {
    const n = Number(value);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return null;
}

function normalizeText(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase();
  return normalized.length > 0 ? normalized : null;
}

export function extractSandboxProfile(agent: RegisteredAgent): SandboxProfile | null {
  if (!agent.metadata || typeof agent.metadata !== 'object') return null;
  const sandbox = (agent.metadata as Record<string, unknown>).sandbox;
  if (!sandbox || typeof sandbox !== 'object' || Array.isArray(sandbox)) return null;

  const sandboxObj = sandbox as Record<string, unknown>;
  const runtime = normalizeText(sandboxObj.runtime);
  const version = normalizeText(sandboxObj.version);
  const cpu = parsePositiveNumber(sandboxObj.cpu);
  const memory = parsePositiveNumber(sandboxObj.memory);

  if (!runtime || !version || cpu === null || memory === null) return null;
  return { runtime, version, cpu, memory };
}

export function checkSandboxParity(
  agents: RegisteredAgent[],
  required = sandboxParityRequiredByDefault()
): SandboxParityResult {
  if (!required) {
    return {
      required: false,
      enforced: false,
      passed: true,
      profiles: {}
    };
  }

  if (agents.length !== 2) {
    return {
      required: true,
      enforced: true,
      passed: false,
      reason: 'exactly_two_agents_required',
      profiles: {}
    };
  }

  const [a, b] = agents;
  const profileA = extractSandboxProfile(a);
  const profileB = extractSandboxProfile(b);

  if (!profileA || !profileB) {
    return {
      required: true,
      enforced: true,
      passed: false,
      reason: !profileA && !profileB ? 'missing_sandbox_profiles' : !profileA ? `missing_sandbox_profile:${a.id}` : `missing_sandbox_profile:${b.id}`,
      profiles: {
        ...(profileA ? { [a.id]: profileA } : {}),
        ...(profileB ? { [b.id]: profileB } : {})
      }
    };
  }

  const mismatchedFields = (['runtime', 'version', 'cpu', 'memory'] as const)
    .filter((field) => profileA[field] !== profileB[field]);

  if (mismatchedFields.length > 0) {
    return {
      required: true,
      enforced: true,
      passed: false,
      reason: `sandbox_profile_mismatch:${mismatchedFields.join(',')}`,
      profiles: {
        [a.id]: profileA,
        [b.id]: profileB
      },
      mismatchedFields: [...mismatchedFields]
    };
  }

  return {
    required: true,
    enforced: true,
    passed: true,
    profiles: {
      [a.id]: profileA,
      [b.id]: profileB
    }
  };
}
