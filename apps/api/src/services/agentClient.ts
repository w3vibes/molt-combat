import { AgentAction, AgentProfile, AgentState, MatchConfig, MatchTurnMetering } from '../types/domain.js';
import { z } from 'zod';

const actionSchema = z.union([
  z.object({ type: z.literal('gather'), resource: z.enum(['energy', 'metal', 'data']), amount: z.number().int().min(1).max(10) }),
  z.object({ type: z.literal('trade'), give: z.enum(['energy', 'metal', 'data']), receive: z.enum(['energy', 'metal', 'data']), amount: z.number().int().min(1).max(10) }),
  z.object({ type: z.literal('attack'), targetAgentId: z.string(), amount: z.number().int().min(1).max(10) }),
  z.object({ type: z.literal('hold') })
]);

function timeoutMs() {
  return Number(process.env.AGENT_TIMEOUT_MS || 7000);
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

export async function requestActionMetered(params: {
  agent: AgentProfile;
  turn: number;
  self: AgentState;
  opponent: AgentState;
  config: MatchConfig;
  sandboxParityEnforced: boolean;
}): Promise<{ action: AgentAction; metering: MatchTurnMetering }> {
  const { agent, sandboxParityEnforced, ...payload } = params;
  const body = JSON.stringify(payload);
  const startedAt = Date.now();
  const timeout = timeoutMs();

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
      sandboxParity: sandboxParityEnforced
    }
  };

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

    const action = actionSchema.parse(parsed) as AgentAction;

    return {
      action,
      metering: {
        ...meteringBase,
        latencyMs: Date.now() - startedAt
      }
    };
  } catch (error) {
    return {
      action: { type: 'hold' },
      metering: {
        ...meteringBase,
        latencyMs: Date.now() - startedAt,
        fallbackHold: true,
        timedOut: isTimeoutError(error),
        invalidAction: error instanceof z.ZodError || error instanceof SyntaxError,
        error: errorMessage(error)
      }
    };
  }
}

export async function requestAction(params: {
  agent: AgentProfile;
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
    actionSchema.parse(body);
    return { ok: true, latencyMs: Date.now() - started };
  } catch (error) {
    return {
      ok: false,
      latencyMs: Date.now() - started,
      error: error instanceof Error ? error.message : 'unknown_error'
    };
  }
}
