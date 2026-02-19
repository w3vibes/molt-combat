import type {
  EigenComputeProfile,
  MatchExecutionMode,
  MatchFairnessAudit,
  MatchRecord,
  SandboxProfile
} from '../types/domain.js';
import type { RegisteredAgent } from './store.js';

export type SandboxParityResult = {
  required: boolean;
  enforced: boolean;
  passed: boolean;
  reason?: string;
  profiles: Record<string, SandboxProfile>;
  mismatchedFields?: Array<keyof SandboxProfile>;
};

export type EigenComputeParityResult = {
  required: boolean;
  enforced: boolean;
  passed: boolean;
  reason?: string;
  profiles: Record<string, EigenComputeProfile>;
  mismatchedFields?: Array<'environment' | 'imageDigest'>;
};

export type StrictSandboxPolicyResult = {
  passed: boolean;
  reason?: string;
  executionMode: MatchExecutionMode;
  endpointModeRequired: boolean;
  endpointModePassed: boolean;
  strictVerified: boolean;
  parity: SandboxParityResult;
  eigenCompute: EigenComputeParityResult;
};

export function sandboxParityRequiredByDefault(): boolean {
  return process.env.MATCH_REQUIRE_SANDBOX_PARITY !== 'false';
}

export function endpointExecutionRequiredByDefault(): boolean {
  return process.env.MATCH_REQUIRE_ENDPOINT_MODE !== 'false';
}

export function eigenComputeRequiredByDefault(): boolean {
  return process.env.MATCH_REQUIRE_EIGENCOMPUTE !== 'false';
}

export function simpleModeEnabledByDefault(): boolean {
  return process.env.MATCH_ALLOW_SIMPLE_MODE === 'true';
}

export function resolveAgentExecutionMode(agent: {
  endpoint: string;
  metadata?: Record<string, unknown>;
}): MatchExecutionMode {
  const metadataMode = typeof agent.metadata?.agentMode === 'string'
    ? agent.metadata.agentMode.trim().toLowerCase()
    : undefined;

  if (metadataMode === 'simple' || metadataMode === 'endpoint') {
    return metadataMode;
  }

  return agent.endpoint.startsWith('https://agent.local/') ? 'simple' : 'endpoint';
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
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
}

function normalizeTextLower(value: unknown): string | null {
  const normalized = normalizeText(value);
  return normalized ? normalized.toLowerCase() : null;
}

function validAppId(value: string): boolean {
  return /^0x[a-fA-F0-9]{40}$/.test(value);
}

export function extractSandboxProfile(agent: RegisteredAgent): SandboxProfile | null {
  if (!agent.metadata || typeof agent.metadata !== 'object') return null;
  const sandbox = (agent.metadata as Record<string, unknown>).sandbox;
  if (!sandbox || typeof sandbox !== 'object' || Array.isArray(sandbox)) return null;

  const sandboxObj = sandbox as Record<string, unknown>;
  const runtime = normalizeTextLower(sandboxObj.runtime);
  const version = normalizeTextLower(sandboxObj.version);
  const cpu = parsePositiveNumber(sandboxObj.cpu);
  const memory = parsePositiveNumber(sandboxObj.memory);

  if (!runtime || !version || cpu === null || memory === null) return null;
  return { runtime, version, cpu, memory };
}

export function extractEigenComputeProfile(agent: RegisteredAgent): EigenComputeProfile | null {
  if (!agent.metadata || typeof agent.metadata !== 'object') return null;
  const metadata = agent.metadata as Record<string, unknown>;

  const eigencompute = metadata.eigencompute;
  if (!eigencompute || typeof eigencompute !== 'object' || Array.isArray(eigencompute)) {
    return null;
  }

  const eigen = eigencompute as Record<string, unknown>;
  const appId = normalizeText(eigen.appId ?? eigen.app_id ?? eigen.ecloudAppId ?? eigen.ecloud_app_id);
  if (!appId) return null;

  const environment = normalizeTextLower(eigen.environment ?? eigen.env ?? metadata.ecloudEnv ?? metadata.ecloud_env);
  const imageDigest = normalizeTextLower(
    eigen.imageDigest ??
    eigen.image_digest ??
    eigen.releaseDigest ??
    eigen.release_digest ??
    eigen.enclaveMeasurement ??
    eigen.enclave_measurement
  );

  return {
    appId,
    ...(environment ? { environment } : {}),
    ...(imageDigest ? { imageDigest } : {})
  };
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

export function checkEigenComputeParity(
  agents: RegisteredAgent[],
  required = eigenComputeRequiredByDefault()
): EigenComputeParityResult {
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
  const profileA = extractEigenComputeProfile(a);
  const profileB = extractEigenComputeProfile(b);

  if (!profileA || !profileB) {
    return {
      required: true,
      enforced: true,
      passed: false,
      reason: !profileA && !profileB
        ? 'missing_eigencompute_profiles'
        : !profileA
          ? `missing_eigencompute_profile:${a.id}`
          : `missing_eigencompute_profile:${b.id}`,
      profiles: {
        ...(profileA ? { [a.id]: profileA } : {}),
        ...(profileB ? { [b.id]: profileB } : {})
      }
    };
  }

  if (!validAppId(profileA.appId)) {
    return {
      required: true,
      enforced: true,
      passed: false,
      reason: `invalid_eigencompute_app_id:${a.id}`,
      profiles: {
        [a.id]: profileA,
        [b.id]: profileB
      }
    };
  }

  if (!validAppId(profileB.appId)) {
    return {
      required: true,
      enforced: true,
      passed: false,
      reason: `invalid_eigencompute_app_id:${b.id}`,
      profiles: {
        [a.id]: profileA,
        [b.id]: profileB
      }
    };
  }

  const mismatchedFields: Array<'environment' | 'imageDigest'> = [];

  if (profileA.environment && profileB.environment && profileA.environment !== profileB.environment) {
    mismatchedFields.push('environment');
  }

  if (profileA.imageDigest && profileB.imageDigest && profileA.imageDigest !== profileB.imageDigest) {
    mismatchedFields.push('imageDigest');
  }

  if (mismatchedFields.length > 0) {
    return {
      required: true,
      enforced: true,
      passed: false,
      reason: `eigencompute_profile_mismatch:${mismatchedFields.join(',')}`,
      profiles: {
        [a.id]: profileA,
        [b.id]: profileB
      },
      mismatchedFields
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

export function evaluateStrictSandboxPolicy(params: {
  agents: RegisteredAgent[];
  executionMode: MatchExecutionMode;
  requireParity?: boolean;
  requireEigenCompute?: boolean;
  endpointModeRequired?: boolean;
}): StrictSandboxPolicyResult {
  const requireParity = params.requireParity ?? sandboxParityRequiredByDefault();
  const requireEigenCompute = params.requireEigenCompute ?? eigenComputeRequiredByDefault();
  const endpointModeRequired = params.endpointModeRequired ?? endpointExecutionRequiredByDefault();

  const parity = checkSandboxParity(params.agents, requireParity);
  const eigenCompute = checkEigenComputeParity(params.agents, requireEigenCompute);

  const nonEndpointAgents = params.agents.filter((agent) => resolveAgentExecutionMode(agent) !== 'endpoint');

  const endpointModePassed = !endpointModeRequired
    ? true
    : params.executionMode === 'endpoint' && nonEndpointAgents.length === 0;

  const reason = !endpointModePassed
    ? nonEndpointAgents.length > 0
      ? `agent_mode_not_endpoint:${nonEndpointAgents.map((agent) => agent.id).join(',')}`
      : 'endpoint_execution_required'
    : !parity.passed
      ? parity.reason
      : !eigenCompute.passed
        ? eigenCompute.reason
        : undefined;

  const passed = endpointModePassed && parity.passed && eigenCompute.passed;
  const strictVerified = passed && params.executionMode === 'endpoint';

  return {
    passed,
    reason,
    executionMode: params.executionMode,
    endpointModeRequired,
    endpointModePassed,
    strictVerified,
    parity,
    eigenCompute
  };
}

export function toMatchFairnessAudit(result: StrictSandboxPolicyResult): MatchFairnessAudit {
  return {
    sandboxParityRequired: result.parity.required,
    sandboxParityEnforced: result.parity.enforced,
    sandboxParityPassed: result.parity.passed,
    sandboxProfiles: result.parity.profiles,
    executionMode: result.executionMode,
    endpointExecutionRequired: result.endpointModeRequired,
    endpointExecutionPassed: result.endpointModePassed,
    eigenComputeRequired: result.eigenCompute.required,
    eigenComputeEnforced: result.eigenCompute.enforced,
    eigenComputePassed: result.eigenCompute.passed,
    eigenComputeProfiles: result.eigenCompute.profiles,
    strictVerified: result.strictVerified,
    rejectionReason: result.reason ?? result.parity.reason ?? result.eigenCompute.reason
  };
}

export function isStrictFairnessAudit(fairness?: MatchFairnessAudit): boolean {
  if (!fairness) return false;
  if (fairness.executionMode !== 'endpoint') return false;
  if (fairness.endpointExecutionRequired && !fairness.endpointExecutionPassed) return false;
  if (fairness.sandboxParityEnforced && !fairness.sandboxParityPassed) return false;
  if (fairness.eigenComputeEnforced && !fairness.eigenComputePassed) return false;
  return fairness.strictVerified === true;
}

export function isStrictSandboxMatch(match?: MatchRecord): boolean {
  if (!match?.audit) return false;
  return isStrictFairnessAudit(match.audit.fairness);
}
