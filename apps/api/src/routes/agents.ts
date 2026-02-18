import { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { checkAgentHealth } from '../services/agentClient.js';
import { requireRole } from '../services/access.js';
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

function resolveAgentMode(agent: { endpoint: string; metadata?: Record<string, unknown> }): 'simple' | 'endpoint' {
  const metadataMode = typeof agent.metadata?.agentMode === 'string' ? agent.metadata.agentMode : undefined;
  if (metadataMode === 'simple' || metadataMode === 'endpoint') return metadataMode;
  return agent.endpoint.startsWith('https://agent.local/') ? 'simple' : 'endpoint';
}

function parseOrReply<T extends z.ZodTypeAny>(schema: T, input: unknown, reply: FastifyReply): z.infer<T> | null {
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    reply.code(400).send({ error: 'invalid_request', issues: parsed.error.issues });
    return null;
  }
  return parsed.data;
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

    const mode: 'simple' | 'endpoint' = body.endpoint ? 'endpoint' : 'simple';

    const saved = store.upsertAgent({
      ...body,
      endpoint: body.endpoint || defaultAgentEndpoint(body.id),
      metadata: {
        ...(body.metadata || {}),
        agentMode: mode
      }
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
    const inferredMode: 'simple' | 'endpoint' = patch.endpoint
      ? 'endpoint'
      : resolveAgentMode({ endpoint: nextEndpoint, metadata: patch.metadata ?? existing.metadata });

    const updated = store.upsertAgent({
      id,
      name: patch.name ?? existing.name,
      endpoint: nextEndpoint,
      apiKey: patch.apiKey ?? existing.apiKey,
      payoutAddress: patch.payoutAddress ?? existing.payoutAddress,
      enabled: patch.enabled ?? existing.enabled,
      metadata: {
        ...(existing.metadata || {}),
        ...(patch.metadata || {}),
        agentMode: inferredMode
      }
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

    if (resolveAgentMode(agent) === 'simple') {
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
