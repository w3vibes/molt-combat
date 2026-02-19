import { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { checkAgentHealth } from '../services/agentClient.js';
import { requireRole } from '../services/access.js';
import { resolveAgentExecutionMode, simpleModeEnabledByDefault } from '../services/fairness.js';
import { store } from '../services/store.js';

const createAgentSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  endpoint: z.string().url().optional(),
  apiKey: z.string().optional(),
  payoutAddress: z.string().optional(),
  enabled: z.boolean().optional(),
  metadata: z.record(z.string(), z.unknown()).optional()
});

const updateAgentSchema = createAgentSchema.omit({ id: true }).partial();

function defaultAgentEndpoint(agentId: string) {
  return `https://agent.local/${encodeURIComponent(agentId)}`;
}

function parseOrReply<T extends z.ZodTypeAny>(schema: T, input: unknown, reply: FastifyReply): z.infer<T> | null {
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    reply.code(400).send({ error: 'invalid_request', issues: parsed.error.issues });
    return null;
  }
  return parsed.data;
}

function requireStrictAgentMetadata(params: {
  mode: 'simple' | 'endpoint';
  metadata?: Record<string, unknown>;
  reply: FastifyReply;
}): boolean {
  if (params.mode === 'simple') return true;

  const sandbox = params.metadata?.sandbox;
  if (!sandbox || typeof sandbox !== 'object' || Array.isArray(sandbox)) {
    params.reply.code(400).send({
      error: 'sandbox_metadata_required',
      message: 'Endpoint mode requires metadata.sandbox with runtime/version/cpu/memory.'
    });
    return false;
  }

  const eigencompute = params.metadata?.eigencompute;
  if (!eigencompute || typeof eigencompute !== 'object' || Array.isArray(eigencompute)) {
    params.reply.code(400).send({
      error: 'eigencompute_metadata_required',
      message: 'Endpoint mode requires metadata.eigencompute with appId.'
    });
    return false;
  }

  return true;
}

export async function agentRoutes(app: FastifyInstance) {
  app.get('/agents', async (req, reply) => {
    if (!requireRole(req, reply, 'readonly')) return;
    const includeDisabled = String((req.query as { includeDisabled?: string }).includeDisabled || '').toLowerCase() === 'true';
    return store.listAgents(includeDisabled);
  });

  app.get('/agents/:id', async (req, reply) => {
    if (!requireRole(req, reply, 'readonly')) return;
    const id = (req.params as { id: string }).id;
    const agent = store.getAgent(id);
    if (!agent) return reply.code(404).send({ error: 'not_found' });
    return agent;
  });

  app.post('/agents', async (req, reply) => {
    if (!requireRole(req, reply, 'admin')) return;
    const body = parseOrReply(createAgentSchema, req.body, reply);
    if (!body) return;

    const allowSimpleMode = simpleModeEnabledByDefault();
    const mode: 'simple' | 'endpoint' = body.endpoint ? 'endpoint' : 'simple';

    if (mode === 'simple' && !allowSimpleMode) {
      return reply.code(400).send({
        error: 'endpoint_required',
        message: 'Simple mode is disabled. Register endpoint agents with strict metadata.'
      });
    }

    const metadata = {
      ...(body.metadata || {}),
      agentMode: mode
    };

    if (!requireStrictAgentMetadata({ mode, metadata, reply })) return;

    const saved = store.upsertAgent({
      ...body,
      endpoint: body.endpoint || defaultAgentEndpoint(body.id),
      metadata
    });
    return reply.code(201).send(saved);
  });

  app.patch('/agents/:id', async (req, reply) => {
    if (!requireRole(req, reply, 'admin')) return;

    const id = (req.params as { id: string }).id;
    const existing = store.getAgent(id);
    if (!existing) return reply.code(404).send({ error: 'not_found' });

    const patch = parseOrReply(updateAgentSchema, req.body, reply);
    if (!patch) return;

    const nextEndpoint = patch.endpoint ?? existing.endpoint;
    const mergedMetadata = {
      ...(existing.metadata || {}),
      ...(patch.metadata || {})
    };

    const inferredMode: 'simple' | 'endpoint' = patch.endpoint
      ? 'endpoint'
      : resolveAgentExecutionMode({ endpoint: nextEndpoint, metadata: mergedMetadata });

    if (inferredMode === 'simple' && !simpleModeEnabledByDefault()) {
      return reply.code(400).send({
        error: 'endpoint_required',
        message: 'Simple mode is disabled. Keep this agent in endpoint mode.'
      });
    }

    const metadata = {
      ...mergedMetadata,
      agentMode: inferredMode
    };

    if (!requireStrictAgentMetadata({ mode: inferredMode, metadata, reply })) return;

    const updated = store.upsertAgent({
      id,
      name: patch.name ?? existing.name,
      endpoint: nextEndpoint,
      apiKey: patch.apiKey ?? existing.apiKey,
      payoutAddress: patch.payoutAddress ?? existing.payoutAddress,
      enabled: patch.enabled ?? existing.enabled,
      metadata
    });

    return updated;
  });

  app.delete('/agents/:id', async (req, reply) => {
    if (!requireRole(req, reply, 'admin')) return;
    const id = (req.params as { id: string }).id;
    const existing = store.getAgent(id);
    if (!existing) return reply.code(404).send({ error: 'not_found' });

    store.disableAgent(id);
    return { ok: true };
  });

  app.post('/agents/:id/health', async (req, reply) => {
    if (!requireRole(req, reply, 'operator')) return;
    const id = (req.params as { id: string }).id;
    const agent = store.getAgent(id);
    if (!agent) return reply.code(404).send({ error: 'not_found' });

    if (resolveAgentExecutionMode(agent) === 'simple') {
      store.setAgentHealth({
        id,
        status: 'healthy',
        error: undefined
      });

      return {
        ok: true,
        latencyMs: 0,
        agentId: id,
        message: 'simple_mode_no_external_health_probe'
      };
    }

    const health = await checkAgentHealth(agent);
    store.setAgentHealth({
      id,
      status: health.ok ? 'healthy' : 'unhealthy',
      error: health.error
    });

    return {
      ok: health.ok,
      latencyMs: health.latencyMs,
      error: health.error,
      agentId: id
    };
  });
}
