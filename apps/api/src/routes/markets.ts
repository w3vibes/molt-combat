import { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { requireRole } from '../services/access.js';
import { verifyMatchAttestation } from '../services/attestation.js';
import {
  endpointExecutionRequiredByDefault,
  evaluateStrictSandboxPolicy,
  isStrictSandboxMatch,
  resolveAgentExecutionMode
} from '../services/fairness.js';
import { assertMarketBetInput, resolveMarketByOutcome } from '../services/markets.js';
import { store } from '../services/store.js';

function parseOrReply<T extends z.ZodTypeAny>(schema: T, input: unknown, reply: FastifyReply): z.infer<T> | null {
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    reply.code(400).send({ error: 'invalid_request', issues: parsed.error.issues });
    return null;
  }
  return parsed.data;
}

function defaultMarketFeeBps(): number {
  const raw = Number(process.env.MARKET_DEFAULT_FEE_BPS || 0);
  if (!Number.isFinite(raw) || raw < 0) return 0;
  return Math.min(Math.floor(raw), 2000);
}

function isMatchTrustedStrict(matchId: string): { ok: boolean; reason?: string } {
  const match = store.getMatch(matchId);
  if (!match) return { ok: false, reason: 'match_not_found' };
  if (!isStrictSandboxMatch(match)) return { ok: false, reason: 'strict_sandbox_unverified' };

  const attestation = store.getMatchAttestation(matchId);
  if (!attestation) return { ok: false, reason: 'attestation_not_found' };

  const verification = verifyMatchAttestation(attestation, match);
  if (!verification.valid) return { ok: false, reason: verification.reason || 'attestation_invalid' };

  return { ok: true };
}

function validateChallengeStrictEligibility(challengeId: string): { ok: boolean; reason?: string } {
  const challenge = store.getChallenge(challengeId);
  if (!challenge) return { ok: false, reason: 'challenge_not_found' };

  if (!challenge.opponentAgentId) {
    return { ok: false, reason: 'challenge_requires_fixed_opponent' };
  }

  const challenger = store.getAgent(challenge.challengerAgentId);
  const opponent = store.getAgent(challenge.opponentAgentId);
  if (!challenger || !challenger.enabled || !opponent || !opponent.enabled) {
    return { ok: false, reason: 'challenge_agents_invalid' };
  }

  const executionMode =
    resolveAgentExecutionMode(challenger) === 'simple' || resolveAgentExecutionMode(opponent) === 'simple'
      ? 'simple'
      : 'endpoint';

  const policy = evaluateStrictSandboxPolicy({
    agents: [challenger, opponent],
    executionMode,
    endpointModeRequired: endpointExecutionRequiredByDefault()
  });

  if (!policy.passed) {
    return { ok: false, reason: policy.reason || 'strict_policy_failed' };
  }

  return { ok: true };
}

export async function marketRoutes(app: FastifyInstance) {
  app.get('/markets', async (req, reply) => {
    if (!requireRole(req, reply, 'readonly')) return;

    const query = parseOrReply(
      z.object({
        status: z.enum(['open', 'locked', 'resolved', 'cancelled']).optional(),
        subjectType: z.enum(['match', 'challenge']).optional(),
        subjectId: z.string().optional()
      }),
      req.query,
      reply
    );
    if (!query) return;

    return {
      ok: true,
      markets: store.listMarkets(query)
    };
  });

  app.get('/markets/:id', async (req, reply) => {
    if (!requireRole(req, reply, 'readonly')) return;
    const id = (req.params as { id: string }).id;
    const market = store.getMarket(id);
    if (!market) return reply.code(404).send({ error: 'not_found' });

    return {
      ok: true,
      market,
      positions: store.listMarketPositions(id)
    };
  });

  app.post('/markets', async (req, reply) => {
    if (!requireRole(req, reply, 'operator')) return;

    const body = parseOrReply(
      z.object({
        subjectType: z.enum(['match', 'challenge']),
        subjectId: z.string().min(1),
        outcomes: z.array(z.string().min(1)).min(2).max(16),
        feeBps: z.number().int().min(0).max(2000).optional(),
        metadata: z.record(z.string(), z.unknown()).optional()
      }),
      req.body,
      reply
    );
    if (!body) return;

    const outcomes = [...new Set(body.outcomes.map((outcome) => outcome.trim()))].filter(Boolean);
    if (outcomes.length < 2) {
      return reply.code(400).send({ error: 'invalid_outcomes', message: 'At least two unique outcomes are required.' });
    }

    if (body.subjectType === 'match') {
      const strict = isMatchTrustedStrict(body.subjectId);
      if (!strict.ok) {
        return reply.code(400).send({
          error: 'strict_market_subject_required',
          reason: strict.reason,
          message: 'Built-in betting is restricted to strict, attested sandbox matches.'
        });
      }
    }

    if (body.subjectType === 'challenge') {
      const strict = validateChallengeStrictEligibility(body.subjectId);
      if (!strict.ok) {
        return reply.code(400).send({
          error: 'strict_market_subject_required',
          reason: strict.reason,
          message: 'Challenge market requires endpoint-only strict sandbox eligibility.'
        });
      }
    }

    const market = store.createMarket({
      subjectType: body.subjectType,
      subjectId: body.subjectId,
      outcomes,
      feeBps: body.feeBps ?? defaultMarketFeeBps(),
      metadata: body.metadata
    });

    return reply.code(201).send({ ok: true, market });
  });

  app.post('/markets/:id/bets', async (req, reply) => {
    if (!requireRole(req, reply, 'operator')) return;
    const id = (req.params as { id: string }).id;

    const body = parseOrReply(
      z.object({
        bettor: z.string().min(1),
        outcome: z.string().min(1),
        amount: z.string().min(1)
      }),
      req.body,
      reply
    );
    if (!body) return;

    try {
      assertMarketBetInput({ outcome: body.outcome, amount: body.amount });
      const position = store.placeMarketBet({
        marketId: id,
        bettor: body.bettor,
        outcome: body.outcome,
        amount: body.amount
      });

      return {
        ok: true,
        position,
        market: store.getMarket(id)
      };
    } catch (error) {
      return reply.code(400).send({
        error: 'bet_rejected',
        message: error instanceof Error ? error.message : 'invalid_bet'
      });
    }
  });

  app.post('/markets/:id/lock', async (req, reply) => {
    if (!requireRole(req, reply, 'operator')) return;

    const id = (req.params as { id: string }).id;
    const market = store.getMarket(id);
    if (!market) return reply.code(404).send({ error: 'not_found' });

    if (market.status !== 'open') {
      return reply.code(400).send({ error: 'invalid_status', status: market.status });
    }

    const locked = store.lockMarket(id);
    return { ok: true, market: locked };
  });

  app.post('/markets/:id/resolve', async (req, reply) => {
    if (!requireRole(req, reply, 'operator')) return;

    const id = (req.params as { id: string }).id;
    const body = parseOrReply(z.object({ outcome: z.string().min(1) }), req.body, reply);
    if (!body) return;

    try {
      const result = resolveMarketByOutcome({
        marketId: id,
        winningOutcome: body.outcome
      });

      return {
        ok: true,
        market: result.market,
        payouts: result.payouts,
        totals: {
          totalPool: result.totalPool,
          feeAmount: result.feeAmount,
          payoutPool: result.payoutPool
        }
      };
    } catch (error) {
      return reply.code(400).send({
        error: 'market_resolve_failed',
        message: error instanceof Error ? error.message : 'unknown_error'
      });
    }
  });

  app.post('/markets/:id/cancel', async (req, reply) => {
    if (!requireRole(req, reply, 'operator')) return;

    const id = (req.params as { id: string }).id;
    const market = store.getMarket(id);
    if (!market) return reply.code(404).send({ error: 'not_found' });
    if (market.status === 'resolved') return reply.code(400).send({ error: 'already_resolved' });

    const cancelled = store.cancelMarket(id);
    return {
      ok: true,
      market: cancelled
    };
  });
}
