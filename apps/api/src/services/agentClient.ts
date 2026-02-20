import {
  AgentAction,
  AgentProfile,
  AgentState,
  MatchConfig,
  MatchMeteringPolicy,
  MatchTurnMetering
} from '../types/domain.js';
import { z } from 'zod';
import {
  EigenTurnProof,
  eigenTurnProofMaxSkewMs,
  newTurnProofChallenge,
  verifyEigenTurnProof
} from './eigenProof.js';

const actionSchema = z.union([
  z.object({ type: z.literal('gather'), resource: z.enum(['energy', 'metal', 'data']), amount: z.number().int().min(1).max(10) }),
  z.object({ type: z.literal('trade'), give: z.enum(['energy', 'metal', 'data']), receive: z.enum(['energy', 'metal', 'data']), amount: z.number().int().min(1).max(10) }),
  z.object({ type: z.literal('attack'), targetAgentId: z.string(), amount: z.number().int().min(1).max(10) }),
  z.object({ type: z.literal('hold') })
]);

const proofSchema: z.ZodType<EigenTurnProof> = z.object({
  version: z.string().optional(),
  challenge: z.string().min(8),
  actionHash: z.string().min(16),
  appId: z.string().min(1),
  environment: z.string().optional(),
  imageDigest: z.string().optional(),
  signer: z.string().min(1),
  signature: z.string().min(1),
  timestamp: z.string().min(1)
});

const decideEnvelopeSchema = z.union([
  actionSchema,
  z.object({
    action: actionSchema,
    proof: proofSchema.optional()
  })
]);

type ParsedDecideResponse = {
  action: AgentAction;
  proof?: EigenTurnProof;
};

type ExpectedEigenProofInput = {
  required: boolean;
  appId: string;
  environment?: string;
  imageDigest?: string;
  signerAddress?: string;
  maxSkewMs?: number;
};

function boundedPositiveInteger(value: string | undefined, fallback: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(Math.floor(parsed), max);
}

function timeoutMs() {
  return boundedPositiveInteger(process.env.AGENT_TIMEOUT_MS, 7000, 120_000);
}

export function currentMeteringPolicy(): MatchMeteringPolicy {
  const timeout = timeoutMs();
  return {
    maxRequestBytes: boundedPositiveInteger(process.env.MATCH_MAX_REQUEST_BYTES, 32 * 1024, 1024 * 1024),
    maxResponseBytes: boundedPositiveInteger(process.env.MATCH_MAX_RESPONSE_BYTES, 256 * 1024, 4 * 1024 * 1024),
    maxLatencyMs: boundedPositiveInteger(process.env.MATCH_MAX_LATENCY_MS, timeout, 120_000)
  };
}

function authHeaders(agent: AgentProfile): Headers {
  const headers = new Headers();
  if (agent.apiKey) headers.set('authorization', `Bearer ${agent.apiKey}`);
  return headers;
}

function jsonHeaders(agent: AgentProfile): Headers {
  const headers = authHeaders(agent);
  headers.set('content-type', 'application/json');
  return headers;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'agent_request_failed';
}

function isTimeoutError(error: unknown): boolean {
  const message = errorMessage(error).toLowerCase();
  return message.includes('timeout') || message.includes('aborted');
}

async function readResponseBody(res: { text?: () => Promise<string>; json?: () => Promise<unknown> }): Promise<{ raw: string; parsed: unknown }> {
  if (typeof res.text === 'function') {
    const raw = await res.text();
    return { raw, parsed: raw ? JSON.parse(raw) : null };
  }

  if (typeof res.json === 'function') {
    const parsed = await res.json();
    const raw = JSON.stringify(parsed);
    return { raw, parsed };
  }

  return { raw: '', parsed: null };
}

function parseDecideResponse(parsed: unknown): ParsedDecideResponse {
  const response = decideEnvelopeSchema.parse(parsed);

  if ('type' in response) {
    return { action: response as AgentAction };
  }

  return {
    action: response.action as AgentAction,
    proof: response.proof
  };
}

function fallbackHold(params: {
  base: MatchTurnMetering;
  startedAt: number;
  policyViolation?: string;
  error?: string;
  timedOut?: boolean;
  invalidAction?: boolean;
  eigenProofVerified?: boolean;
  eigenProofReason?: string;
}) {
  return {
    action: { type: 'hold' } as AgentAction,
    metering: {
      ...params.base,
      latencyMs: Date.now() - params.startedAt,
      fallbackHold: true,
      timedOut: params.timedOut ?? false,
      invalidAction: params.invalidAction ?? false,
      policyViolation: params.policyViolation,
      error: params.error,
      eigenProofVerified: params.eigenProofVerified,
      eigenProofReason: params.eigenProofReason
    }
  };
}

function verifyProofIfPresent(params: {
  action: AgentAction;
  proof?: EigenTurnProof;
  challenge?: string;
  expected?: ExpectedEigenProofInput;
  matchId?: string;
  turn: number;
  agentId: string;
}): { ok: boolean; reason?: string; required: boolean } {
  const required = Boolean(params.expected?.required);

  if (required && (!params.matchId || !params.challenge || !params.expected)) {
    return { ok: false, reason: 'missing_proof_context', required };
  }

  if (required && !params.proof) {
    return { ok: false, reason: 'missing_eigen_turn_proof', required };
  }

  if (!params.proof || !params.challenge || !params.expected || !params.matchId) {
    return { ok: true, required };
  }

  const verification = verifyEigenTurnProof({
    action: params.action,
    proof: params.proof,
    expected: {
      required: required,
      matchId: params.matchId,
      turn: params.turn,
      agentId: params.agentId,
      appId: params.expected.appId,
      environment: params.expected.environment,
      imageDigest: params.expected.imageDigest,
      signerAddress: params.expected.signerAddress
    },
    challenge: params.challenge,
    maxSkewMs: params.expected.maxSkewMs ?? eigenTurnProofMaxSkewMs()
  });

  return {
    ok: verification.valid,
    reason: verification.reason,
    required
  };
}

export async function requestActionMetered(params: {
  agent: AgentProfile;
  matchId?: string;
  turn: number;
  self: AgentState;
  opponent: AgentState;
  config: MatchConfig;
  sandboxParityEnforced: boolean;
  expectedEigenProof?: ExpectedEigenProofInput;
}): Promise<{ action: AgentAction; metering: MatchTurnMetering }> {
  const { agent, sandboxParityEnforced, expectedEigenProof, matchId, ...payload } = params;
  const proofChallenge = expectedEigenProof?.required ? newTurnProofChallenge() : undefined;

  const requestPayload: Record<string, unknown> = {
    ...payload,
    ...(proofChallenge ? { proofChallenge, proofVersion: 'v1' } : {})
  };

  const body = JSON.stringify(requestPayload);
  const startedAt = Date.now();
  const timeout = timeoutMs();
  const meteringPolicy = currentMeteringPolicy();

  const meteringBase: MatchTurnMetering = {
    agentId: agent.id,
    latencyMs: 0,
    requestBytes: Buffer.byteLength(body),
    responseBytes: 0,
    timeoutMs: timeout,
    timedOut: false,
    fallbackHold: false,
    invalidAction: false,
    enforcement: {
      timeout: true,
      schemaValidation: true,
      sandboxParity: sandboxParityEnforced,
      meteringPolicy: true,
      eigenProof: Boolean(expectedEigenProof?.required)
    }
  };

  if (meteringBase.requestBytes > meteringPolicy.maxRequestBytes) {
    return fallbackHold({
      base: meteringBase,
      startedAt,
      policyViolation: `request_bytes_exceeded:${meteringBase.requestBytes}>${meteringPolicy.maxRequestBytes}`,
      error: 'request_bytes_limit_exceeded'
    });
  }

  try {
    const res = await fetch(`${agent.endpoint}/decide`, {
      method: 'POST',
      headers: jsonHeaders(agent),
      body,
      signal: AbortSignal.timeout(timeout)
    });

    meteringBase.httpStatus = res.status;

    if (!res.ok) {
      throw new Error(`agent_http_${res.status}`);
    }

    const { raw, parsed } = await readResponseBody(res as unknown as { text?: () => Promise<string>; json?: () => Promise<unknown> });
    meteringBase.responseBytes = Buffer.byteLength(raw);

    const response = parseDecideResponse(parsed);
    const action = response.action;
    const latencyMs = Date.now() - startedAt;

    if (meteringBase.responseBytes > meteringPolicy.maxResponseBytes) {
      return fallbackHold({
        base: meteringBase,
        startedAt,
        policyViolation: `response_bytes_exceeded:${meteringBase.responseBytes}>${meteringPolicy.maxResponseBytes}`,
        error: 'response_bytes_limit_exceeded'
      });
    }

    if (latencyMs > meteringPolicy.maxLatencyMs) {
      return fallbackHold({
        base: meteringBase,
        startedAt,
        policyViolation: `latency_exceeded:${latencyMs}>${meteringPolicy.maxLatencyMs}`,
        error: 'latency_limit_exceeded'
      });
    }

    const proofResult = verifyProofIfPresent({
      action,
      proof: response.proof,
      challenge: proofChallenge,
      expected: expectedEigenProof,
      matchId,
      turn: params.turn,
      agentId: agent.id
    });

    if (!proofResult.ok && proofResult.required) {
      return fallbackHold({
        base: meteringBase,
        startedAt,
        policyViolation: `eigen_turn_proof_failed:${proofResult.reason || 'unknown'}`,
        error: 'eigen_turn_proof_failed',
        eigenProofVerified: false,
        eigenProofReason: proofResult.reason
      });
    }

    return {
      action,
      metering: {
        ...meteringBase,
        latencyMs,
        eigenProofVerified: proofResult.ok,
        eigenProofReason: proofResult.ok ? undefined : proofResult.reason
      }
    };
  } catch (error) {
    return fallbackHold({
      base: meteringBase,
      startedAt,
      timedOut: isTimeoutError(error),
      invalidAction: error instanceof z.ZodError || error instanceof SyntaxError,
      error: errorMessage(error)
    });
  }
}

export async function requestAction(params: {
  agent: AgentProfile;
  matchId?: string;
  turn: number;
  self: AgentState;
  opponent: AgentState;
  config: MatchConfig;
}): Promise<AgentAction> {
  const result = await requestActionMetered({
    ...params,
    sandboxParityEnforced: false
  });
  return result.action;
}

export async function checkAgentHealth(agent: AgentProfile): Promise<{ ok: boolean; latencyMs: number; error?: string }> {
  const started = Date.now();

  try {
    const health = await fetch(`${agent.endpoint}/health`, {
      method: 'GET',
      headers: authHeaders(agent),
      signal: AbortSignal.timeout(timeoutMs())
    });

    if (health.ok) {
      return { ok: true, latencyMs: Date.now() - started };
    }

    // Fallback for agents that do not expose /health.
    if (health.status !== 404) {
      return { ok: false, latencyMs: Date.now() - started, error: `Health endpoint returned ${health.status}` };
    }
  } catch {
    // Continue to decide-probe fallback.
  }

  try {
    const probe = await fetch(`${agent.endpoint}/decide`, {
      method: 'POST',
      headers: jsonHeaders(agent),
      body: JSON.stringify({
        turn: 1,
        self: { agentId: 'probe_self', hp: 100, wallet: { energy: 1, metal: 1, data: 1 }, score: 0 },
        opponent: { agentId: 'probe_opp', hp: 100, wallet: { energy: 1, metal: 1, data: 1 }, score: 0 },
        config: { maxTurns: 1, seed: 1, attackCost: 1, attackDamage: 1 }
      }),
      signal: AbortSignal.timeout(timeoutMs())
    });

    if (!probe.ok) {
      return { ok: false, latencyMs: Date.now() - started, error: `Decide probe returned ${probe.status}` };
    }

    const body = await probe.json();
    parseDecideResponse(body);
    return { ok: true, latencyMs: Date.now() - started };
  } catch (error) {
    return {
      ok: false,
      latencyMs: Date.now() - started,
      error: error instanceof Error ? error.message : 'unknown_error'
    };
  }
}
