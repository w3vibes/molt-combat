import Fastify from 'fastify';
import cors from '@fastify/cors';
import swagger from '@fastify/swagger';
import swaggerUI from '@fastify/swagger-ui';
import rateLimit from '@fastify/rate-limit';
import { matchRoutes } from './routes/matches.js';
import { agentRoutes } from './routes/agents.js';
import { challengeRoutes } from './routes/challenges.js';
import { installRoutes } from './routes/install.js';
import { marketRoutes } from './routes/markets.js';
import { leaderboardRoutes } from './routes/leaderboard.js';
import { automationRoutes } from './routes/automation.js';
import { tournamentRoutes } from './routes/tournaments.js';
import {
  maybeStartEscrowSettlementPolling,
  stopEscrowSettlementPolling
} from './services/automation.js';
import { metrics } from './services/metrics.js';
import { store } from './services/store.js';

const app = Fastify({ logger: true });

await app.register(cors, { origin: true });
await app.register(swagger, { openapi: { info: { title: 'MoltCombat API', version: '0.2.0' } } });
await app.register(swaggerUI, { routePrefix: '/docs' });
await app.register(rateLimit, {
  max: Number(process.env.API_RATE_LIMIT_MAX || 120),
  timeWindow: process.env.API_RATE_LIMIT_WINDOW || '1 minute'
});

app.addHook('onRequest', async (req) => {
  (req as typeof req & { _startedAt?: number })._startedAt = Date.now();
});

app.addHook('onResponse', async (req, reply) => {
  const startedAt = (req as typeof req & { _startedAt?: number })._startedAt || Date.now();
  metrics.observe({
    route: req.routeOptions.url || req.url,
    method: req.method,
    statusCode: reply.statusCode,
    durationMs: Date.now() - startedAt
  });
});

app.addHook('onClose', async () => {
  stopEscrowSettlementPolling();
});

await app.register(matchRoutes);
await app.register(agentRoutes);
await app.register(challengeRoutes);
await app.register(installRoutes);
await app.register(marketRoutes);
await app.register(leaderboardRoutes);
await app.register(automationRoutes);
await app.register(tournamentRoutes);

app.get('/health', { config: { rateLimit: false } }, async () => ({ ok: true }));

app.get('/metrics', { config: { rateLimit: false } }, async () => {
  return {
    ok: true,
    metrics: metrics.snapshot(),
    store: store.stats()
  };
});

const autoStart = maybeStartEscrowSettlementPolling();
app.log.info({ automation: autoStart }, 'escrow automation bootstrap');

const port = Number(process.env.PORT || 3000);
app.listen({ port, host: '0.0.0.0' }).catch((err) => {
  app.log.error(err);
  process.exit(1);
});
