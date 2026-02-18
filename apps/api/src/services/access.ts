import { FastifyReply, FastifyRequest } from 'fastify';
import { store } from './store.js';

export type AccessRole = 'public' | 'readonly' | 'agent' | 'operator' | 'admin';

type AccessContext = {
  role: AccessRole;
  actorAgentId?: string;
};

const ACCESS_CONTEXT_KEY = Symbol('moltcombat.accessContext');

const ROLE_LEVEL: Record<AccessRole, number> = {
  public: 0,
  readonly: 1,
  agent: 2,
  operator: 3,
  admin: 4
};

function configuredKeys() {
  return {
    admin: process.env.ADMIN_API_KEY?.trim(),
    operator: process.env.OPERATOR_API_KEY?.trim(),
    readonly: process.env.READONLY_API_KEY?.trim()
  };
}

function extractApiKey(req: FastifyRequest): string | undefined {
  const authHeader = req.headers.authorization;
  if (authHeader?.toLowerCase().startsWith('bearer ')) {
    return authHeader.slice(7).trim();
  }

  const xApiKey = req.headers['x-api-key'];
  if (typeof xApiKey === 'string') return xApiKey.trim();
  if (Array.isArray(xApiKey)) return xApiKey[0]?.trim();
  return undefined;
}

function resolveAccessContext(req: FastifyRequest): AccessContext {
  const request = req as FastifyRequest & { [ACCESS_CONTEXT_KEY]?: AccessContext };
  const cached = request[ACCESS_CONTEXT_KEY];
  if (cached) return cached;

  const keys = configuredKeys();
  const hasAnyGlobalKey = Boolean(keys.admin || keys.operator || keys.readonly);
  const allowPublicRead = process.env.ALLOW_PUBLIC_READ !== 'false';
  const token = extractApiKey(req);

  let context: AccessContext;

  if (!hasAnyGlobalKey) {
    if (token) {
      const agent = store.findAgentByApiKey(token);
      if (agent) {
        context = { role: 'agent', actorAgentId: agent.id };
      } else {
        context = { role: 'admin' };
      }
    } else {
      context = { role: 'admin' };
    }

    request[ACCESS_CONTEXT_KEY] = context;
    return context;
  }

  if (!token) {
    context = { role: allowPublicRead ? 'readonly' : 'public' };
    request[ACCESS_CONTEXT_KEY] = context;
    return context;
  }

  if (keys.admin && token === keys.admin) {
    context = { role: 'admin' };
    request[ACCESS_CONTEXT_KEY] = context;
    return context;
  }

  if (keys.operator && token === keys.operator) {
    context = { role: 'operator' };
    request[ACCESS_CONTEXT_KEY] = context;
    return context;
  }

  if (keys.readonly && token === keys.readonly) {
    context = { role: 'readonly' };
    request[ACCESS_CONTEXT_KEY] = context;
    return context;
  }

  const agent = store.findAgentByApiKey(token);
  if (agent) {
    context = { role: 'agent', actorAgentId: agent.id };
    request[ACCESS_CONTEXT_KEY] = context;
    return context;
  }

  context = { role: 'public' };
  request[ACCESS_CONTEXT_KEY] = context;
  return context;
}

export function resolveAccessRole(req: FastifyRequest): AccessRole {
  return resolveAccessContext(req).role;
}

export function resolveActorAgentId(req: FastifyRequest): string | undefined {
  return resolveAccessContext(req).actorAgentId;
}

export function requireRole(req: FastifyRequest, reply: FastifyReply, role: AccessRole): boolean {
  const actualRole = resolveAccessRole(req);
  if (ROLE_LEVEL[actualRole] >= ROLE_LEVEL[role]) return true;

  reply.code(401).send({
    error: 'unauthorized',
    requiredRole: role,
    currentRole: actualRole
  });
  return false;
}

export function authSummary() {
  const keys = configuredKeys();
  return {
    allowPublicRead: process.env.ALLOW_PUBLIC_READ !== 'false',
    hasAdminKey: Boolean(keys.admin),
    hasOperatorKey: Boolean(keys.operator),
    hasReadonlyKey: Boolean(keys.readonly),
    acceptsAgentApiKeys: true
  };
}
