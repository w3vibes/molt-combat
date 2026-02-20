import type {
  EigenComputeProfile,
  MatchCollusionMetrics,
  MatchExecutionMode,
  MatchFairnessAudit,
  MatchRecord,
  SandboxProfile
} from '../types/domain.js';
import { eigenSignerRequiredByDefault, eigenTurnProofRequiredByDefault } from './eigenProof.js';
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
  requireEnvironment: boolean;
  requireImageDigest: boolean;
  requireSigner: boolean;
  mismatchedFields?: Array<'environment' | 'imageDigest'>;
};

export type AgentIndependenceResult = {
  required: boolean;
  enforced: boolean;
  passed: boolean;
  reason?: string;
  reasons: string[];
};

export type CollusionRiskResult = {
  required: boolean;
  enforced: boolean;
  passed: boolean;
  reason?: string;
  reasons: string[];
  metrics?: MatchCollusionMetrics;
};

export type EigenTurnProofPolicyResult = {
  required: boolean;
  signerRequired: boolean;
  passed: boolean;
  reason?: string;
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
  eigenTurnProof: EigenTurnProofPolicyResult;
  independence: AgentIndependenceResult;
  collusion: CollusionRiskResult;
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

export function eigenComputeEnvironmentRequiredByDefault(): boolean {
  return process.env.MATCH_REQUIRE_EIGENCOMPUTE_ENVIRONMENT !== 'false';
}

export function eigenComputeImageDigestRequiredByDefault(): boolean {
  return process.env.MATCH_REQUIRE_EIGENCOMPUTE_IMAGE_DIGEST !== 'false';
}

export function independentAgentsRequiredByDefault(): boolean {
  return process.env.MATCH_REQUIRE_INDEPENDENT_AGENTS !== 'false';
}

export function antiCollusionRequiredByDefault(): boolean {
  return process.env.MATCH_REQUIRE_ANTI_COLLUSION !== 'false';
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

function normalizeAddress(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.toLowerCase();
}

function endpointHost(endpoint: string): string | null {
  try {
    return new URL(endpoint).host.toLowerCase();
  } catch {
    return null;
  }
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

  const signerAddress = normalizeAddress(
    eigen.signerAddress ??
    eigen.signer ??
    eigen.evmAddress ??
    metadata.ecloudSignerAddress ??
    metadata.ecloud_signer_address
  );

  return {
    appId,
    ...(environment ? { environment } : {}),
    ...(imageDigest ? { imageDigest } : {}),
    ...(signerAddress ? { signerAddress } : {})
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
  params?: {
    required?: boolean;
    requireEnvironment?: boolean;
    requireImageDigest?: boolean;
    requireSigner?: boolean;
  }
): EigenComputeParityResult {
  const required = params?.required ?? eigenComputeRequiredByDefault();
  const requireEnvironment = params?.requireEnvironment ?? eigenComputeEnvironmentRequiredByDefault();
  const requireImageDigest = params?.requireImageDigest ?? eigenComputeImageDigestRequiredByDefault();
  const requireSigner = params?.requireSigner ?? eigenSignerRequiredByDefault();

  if (!required) {
    return {
      required: false,
      enforced: false,
      passed: true,
      profiles: {},
      requireEnvironment,
      requireImageDigest,
      requireSigner
    };
  }

  if (agents.length !== 2) {
    return {
      required: true,
      enforced: true,
      passed: false,
      reason: 'exactly_two_agents_required',
      profiles: {},
      requireEnvironment,
      requireImageDigest,
      requireSigner
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
      },
      requireEnvironment,
      requireImageDigest,
      requireSigner
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
      },
      requireEnvironment,
      requireImageDigest,
      requireSigner
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
      },
      requireEnvironment,
      requireImageDigest,
      requireSigner
    };
  }

  if (requireEnvironment) {
    if (!profileA.environment || !profileB.environment) {
      return {
        required: true,
        enforced: true,
        passed: false,
        reason: !profileA.environment && !profileB.environment
          ? 'missing_eigencompute_environment_profiles'
          : !profileA.environment
            ? `missing_eigencompute_environment:${a.id}`
            : `missing_eigencompute_environment:${b.id}`,
        profiles: {
          [a.id]: profileA,
          [b.id]: profileB
        },
        requireEnvironment,
        requireImageDigest,
        requireSigner
      };
    }
  }

  if (requireImageDigest) {
    if (!profileA.imageDigest || !profileB.imageDigest) {
      return {
        required: true,
        enforced: true,
        passed: false,
        reason: !profileA.imageDigest && !profileB.imageDigest
          ? 'missing_eigencompute_image_digest_profiles'
          : !profileA.imageDigest
            ? `missing_eigencompute_image_digest:${a.id}`
            : `missing_eigencompute_image_digest:${b.id}`,
        profiles: {
          [a.id]: profileA,
          [b.id]: profileB
        },
        requireEnvironment,
        requireImageDigest,
        requireSigner
      };
    }
  }

  if (requireSigner) {
    if (!profileA.signerAddress || !profileB.signerAddress) {
      return {
        required: true,
        enforced: true,
        passed: false,
        reason: !profileA.signerAddress && !profileB.signerAddress
          ? 'missing_eigencompute_signer_profiles'
          : !profileA.signerAddress
            ? `missing_eigencompute_signer:${a.id}`
            : `missing_eigencompute_signer:${b.id}`,
        profiles: {
          [a.id]: profileA,
          [b.id]: profileB
        },
        requireEnvironment,
        requireImageDigest,
        requireSigner
      };
    }
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
      requireEnvironment,
      requireImageDigest,
      requireSigner,
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
    },
    requireEnvironment,
    requireImageDigest,
    requireSigner
  };
}

export function checkAgentIndependence(
  agents: RegisteredAgent[],
  required = independentAgentsRequiredByDefault()
): AgentIndependenceResult {
  if (!required) {
    return {
      required: false,
      enforced: false,
      passed: true,
      reasons: []
    };
  }

  if (agents.length !== 2) {
    return {
      required: true,
      enforced: true,
      passed: false,
      reason: 'exactly_two_agents_required',
      reasons: ['exactly_two_agents_required']
    };
  }

  const [a, b] = agents;
  const reasons: string[] = [];

  const hostA = endpointHost(a.endpoint);
  const hostB = endpointHost(b.endpoint);
  if (hostA && hostB && hostA === hostB) {
    reasons.push('shared_endpoint_host');
  }

  const payoutA = normalizeAddress(a.payoutAddress);
  const payoutB = normalizeAddress(b.payoutAddress);
  if (payoutA && payoutB && payoutA === payoutB) {
    reasons.push('shared_payout_address');
  }

  const keyA = normalizeText(a.apiKey);
  const keyB = normalizeText(b.apiKey);
  if (keyA && keyB && keyA === keyB) {
    reasons.push('shared_agent_api_key');
  }

  const eigenA = extractEigenComputeProfile(a);
  const eigenB = extractEigenComputeProfile(b);
  if (eigenA?.appId && eigenB?.appId && eigenA.appId.toLowerCase() === eigenB.appId.toLowerCase()) {
    reasons.push('shared_eigencompute_app');
  }

  if (eigenA?.signerAddress && eigenB?.signerAddress && eigenA.signerAddress === eigenB.signerAddress) {
    reasons.push('shared_eigencompute_signer');
  }

  if (reasons.length > 0) {
    return {
      required: true,
      enforced: true,
      passed: false,
      reason: `agent_independence_failed:${reasons.join(',')}`,
      reasons
    };
  }

  return {
    required: true,
    enforced: true,
    passed: true,
    reasons: []
  };
}

function defaultCollusionRisk(required: boolean): CollusionRiskResult {
  return {
    required,
    enforced: false,
    passed: true,
    reasons: []
  };
}

function resolveEigenTurnProofPolicy(params: {
  required: boolean;
  signerRequired: boolean;
  eigenCompute: EigenComputeParityResult;
}): EigenTurnProofPolicyResult {
  if (!params.required) {
    return {
      required: false,
      signerRequired: params.signerRequired,
      passed: true
    };
  }

  if (!params.eigenCompute.passed) {
    return {
      required: true,
      signerRequired: params.signerRequired,
      passed: false,
      reason: params.eigenCompute.reason || 'eigencompute_policy_failed'
    };
  }

  if (params.signerRequired) {
    const missingSigner = Object.entries(params.eigenCompute.profiles)
      .find(([, profile]) => !profile.signerAddress);

    if (missingSigner) {
      return {
        required: true,
        signerRequired: true,
        passed: false,
        reason: `missing_eigencompute_signer:${missingSigner[0]}`
      };
    }
  }

  return {
    required: true,
    signerRequired: params.signerRequired,
    passed: true
  };
}

export function evaluateStrictSandboxPolicy(params: {
  agents: RegisteredAgent[];
  executionMode: MatchExecutionMode;
  requireParity?: boolean;
  requireEigenCompute?: boolean;
  endpointModeRequired?: boolean;
  requireIndependentAgents?: boolean;
  requireEigenTurnProof?: boolean;
  requireEigenSigner?: boolean;
  collusionRisk?: CollusionRiskResult;
}): StrictSandboxPolicyResult {
  const requireParity = params.requireParity ?? sandboxParityRequiredByDefault();
  const requireEigenCompute = params.requireEigenCompute ?? eigenComputeRequiredByDefault();
  const requireEigenSigner = params.requireEigenSigner ?? eigenSignerRequiredByDefault();
  const requireEigenTurnProof = params.requireEigenTurnProof ?? eigenTurnProofRequiredByDefault();
  const endpointModeRequired = params.endpointModeRequired ?? endpointExecutionRequiredByDefault();
  const requireIndependentAgents = params.requireIndependentAgents ?? independentAgentsRequiredByDefault();
  const requireAntiCollusion = antiCollusionRequiredByDefault();

  const parity = checkSandboxParity(params.agents, requireParity);
  const eigenCompute = checkEigenComputeParity(params.agents, {
    required: requireEigenCompute,
    requireSigner: requireEigenSigner
  });
  const eigenTurnProof = resolveEigenTurnProofPolicy({
    required: requireEigenTurnProof,
    signerRequired: requireEigenSigner,
    eigenCompute
  });
  const independence = checkAgentIndependence(params.agents, requireIndependentAgents);

  const collusion = params.collusionRisk
    ? {
      ...params.collusionRisk,
      required: requireAntiCollusion
    }
    : defaultCollusionRisk(requireAntiCollusion);

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
        : !eigenTurnProof.passed
          ? eigenTurnProof.reason
          : !independence.passed
            ? independence.reason
            : collusion.required && collusion.enforced && !collusion.passed
              ? collusion.reason || (collusion.reasons.length > 0 ? `collusion_risk:${collusion.reasons.join(',')}` : 'collusion_risk_detected')
              : undefined;

  const passed = endpointModePassed
    && parity.passed
    && eigenCompute.passed
    && eigenTurnProof.passed
    && independence.passed
    && (!collusion.required || !collusion.enforced || collusion.passed);

  const strictVerified = passed && params.executionMode === 'endpoint';

  return {
    passed,
    reason,
    executionMode: params.executionMode,
    endpointModeRequired,
    endpointModePassed,
    strictVerified,
    parity,
    eigenCompute,
    eigenTurnProof,
    independence,
    collusion
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
    eigenComputeEnvironmentRequired: result.eigenCompute.requireEnvironment,
    eigenComputeImageDigestRequired: result.eigenCompute.requireImageDigest,
    eigenSignerRequired: result.eigenCompute.requireSigner,
    eigenTurnProofRequired: result.eigenTurnProof.required,
    eigenTurnProofPassed: result.eigenTurnProof.passed,
    independentAgentsRequired: result.independence.required,
    independentAgentsPassed: result.independence.passed,
    independentAgentsReasons: result.independence.reasons,
    collusionCheckRequired: result.collusion.required,
    collusionCheckPassed: result.collusion.passed,
    collusionRiskReasons: result.collusion.reasons,
    collusionMetrics: result.collusion.metrics,
    strictVerified: result.strictVerified,
    rejectionReason: result.reason
      ?? result.parity.reason
      ?? result.eigenCompute.reason
      ?? result.eigenTurnProof.reason
      ?? result.independence.reason
      ?? result.collusion.reason
  };
}

export function isStrictFairnessAudit(fairness?: MatchFairnessAudit): boolean {
  if (!fairness) return false;
  if (fairness.executionMode !== 'endpoint') return false;
  if (fairness.endpointExecutionRequired && !fairness.endpointExecutionPassed) return false;
  if (fairness.sandboxParityEnforced && !fairness.sandboxParityPassed) return false;
  if (fairness.eigenComputeEnforced && !fairness.eigenComputePassed) return false;
  if (fairness.independentAgentsRequired && fairness.independentAgentsPassed !== true) return false;
  if (fairness.collusionCheckRequired && fairness.collusionCheckPassed !== true) return false;
  if (fairness.eigenTurnProofRequired && fairness.eigenTurnProofPassed !== true) return false;
  if (fairness.eigenSignerRequired) {
    const profiles = Object.values(fairness.eigenComputeProfiles || {});
    if (profiles.length === 0 || profiles.some((profile) => !profile.signerAddress)) return false;
  }
  return fairness.strictVerified === true;
}

export function isStrictSandboxMatch(match?: MatchRecord): boolean {
  if (!match?.audit) return false;
  return isStrictFairnessAudit(match.audit.fairness);
}
