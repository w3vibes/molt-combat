import { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { requireRole } from '../services/access.js';
import { store } from '../services/store.js';
import { tournamentStore } from '../services/tournaments.js';
import {
  MatchConfig,
  TournamentFixtureRecord,
  TournamentRecord,
  TournamentRoundRecord,
  TournamentStatus
} from '../types/domain.js';

const DEFAULT_CONFIG: MatchConfig = {
  maxTurns: 30,
  seed: 1,
  attackCost: 1,
  attackDamage: 4
};

const configSchema = z.object({
  maxTurns: z.number().int().min(1).max(200),
  seed: z.number().int(),
  attackCost: z.number().int().min(1),
  attackDamage: z.number().int().min(1)
});

const stakeSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('none') }),
  z.object({
    mode: z.literal('usdc'),
    contractAddress: z.string(),
    amountPerPlayer: z.string(),
    playerA: z.string().optional(),
    playerB: z.string().optional()
  }),
  z.object({
    mode: z.literal('eth'),
    contractAddress: z.string(),
    amountEth: z.string(),
    autoFund: z.boolean().optional()
  })
]);

function parseOrReply<T extends z.ZodTypeAny>(schema: T, input: unknown, reply: FastifyReply): z.infer<T> | null {
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    reply.code(400).send({ error: 'invalid_request', issues: parsed.error.issues });
    return null;
  }
  return parsed.data;
}

function tournamentDetails(tournamentId: string): {
  tournament: TournamentRecord;
  rounds: TournamentRoundRecord[];
  fixtures: TournamentFixtureRecord[];
} | null {
  const tournament = tournamentStore.getTournament(tournamentId);
  if (!tournament) return null;

  const rounds = tournamentStore.listTournamentRounds(tournamentId);
  const fixtures = tournamentStore.listTournamentFixtures(tournamentId);

  return { tournament, rounds, fixtures };
}

function resolveNextRoundToLaunch(tournamentId: string): number | null {
  const rounds = tournamentStore.listTournamentRounds(tournamentId);
  const fixtures = tournamentStore.listTournamentFixtures(tournamentId);

  for (const round of rounds) {
    const roundFixtures = fixtures.filter((fixture) => fixture.roundNumber === round.roundNumber);
    const launchable = roundFixtures.some((fixture) =>
      fixture.status === 'ready' &&
      !fixture.challengeId &&
      Boolean(fixture.agentAId) &&
      Boolean(fixture.agentBId)
    );

    if (launchable) return round.roundNumber;

    const unresolved = roundFixtures.some((fixture) => fixture.status !== 'completed' && fixture.status !== 'cancelled');
    if (unresolved) return round.roundNumber;
  }

  return rounds.length > 0 ? rounds[rounds.length - 1].roundNumber : null;
}

function syncFixturesFromChallenges(tournamentId: string) {
  const fixtures = tournamentStore.listTournamentFixtures(tournamentId);
  let synced = 0;
  let skipped = 0;

  for (const fixture of fixtures) {
    if (!fixture.challengeId) {
      skipped += 1;
      continue;
    }

    const challenge = store.getChallenge(fixture.challengeId);
    if (!challenge) {
      skipped += 1;
      continue;
    }

    tournamentStore.syncFixtureFromChallenge({
      tournamentId,
      fixtureId: fixture.id,
      challengeId: challenge.id,
      challengeStatus: challenge.status,
      challengeMatchId: challenge.matchId,
      challengeWinnerAgentId: challenge.winnerAgentId
    });
    synced += 1;
  }

  tournamentStore.propagateTournament(tournamentId);
  return { synced, skipped };
}

function launchRoundFixtures(params: {
  tournament: TournamentRecord;
  roundNumber: number;
}): {
  createdChallenges: Array<{ fixtureId: string; challengeId: string }>;
  skippedFixtures: Array<{ fixtureId: string; reason: string }>;
} {
  const createdChallenges: Array<{ fixtureId: string; challengeId: string }> = [];
  const skippedFixtures: Array<{ fixtureId: string; reason: string }> = [];

  const fixtures = tournamentStore.listTournamentFixtures(params.tournament.id, params.roundNumber);

  for (const fixture of fixtures) {
    if (fixture.status === 'completed' || fixture.status === 'cancelled') {
      skippedFixtures.push({ fixtureId: fixture.id, reason: 'fixture_closed' });
      continue;
    }

    if (fixture.challengeId) {
      skippedFixtures.push({ fixtureId: fixture.id, reason: 'challenge_already_created' });
      continue;
    }

    if (!fixture.agentAId || !fixture.agentBId) {
      skippedFixtures.push({ fixtureId: fixture.id, reason: 'fixture_not_ready' });
      continue;
    }

    const challenger = store.getAgent(fixture.agentAId);
    const opponent = store.getAgent(fixture.agentBId);

    if (!challenger || !challenger.enabled || !opponent || !opponent.enabled) {
      skippedFixtures.push({ fixtureId: fixture.id, reason: 'disabled_or_missing_agent' });
      continue;
    }

    const topic = `${params.tournament.name} • R${params.roundNumber} • Match ${fixture.slotNumber}`;

    const templateStake = structuredClone(params.tournament.challengeTemplate.stake);

    if (templateStake.mode === 'usdc') {
      templateStake.playerA = templateStake.playerA || challenger.payoutAddress;
      templateStake.playerB = templateStake.playerB || opponent.payoutAddress;

      if (!templateStake.playerA || !templateStake.playerB) {
        skippedFixtures.push({ fixtureId: fixture.id, reason: 'missing_usdc_player_wallets' });
        continue;
      }
    }

    const challenge = store.createChallenge({
      topic,
      challengerAgentId: fixture.agentAId,
      opponentAgentId: fixture.agentBId,
      config: params.tournament.challengeTemplate.config,
      stake: templateStake,
      notes: [
        params.tournament.challengeTemplate.notesPrefix,
        `tournament_id:${params.tournament.id}`,
        `tournament_round:${params.roundNumber}`,
        `tournament_fixture:${fixture.id}`
      ].filter(Boolean).join('\n'),
      status: 'accepted'
    });

    tournamentStore.patchTournamentFixture(fixture.id, {
      challengeId: challenge.id,
      status: 'running'
    });

    createdChallenges.push({ fixtureId: fixture.id, challengeId: challenge.id });
  }

  tournamentStore.propagateTournament(params.tournament.id);

  return { createdChallenges, skippedFixtures };
}

export async function tournamentRoutes(app: FastifyInstance) {
  app.get('/seasons', async (req, reply) => {
    if (!requireRole(req, reply, 'readonly')) return;

    const parsed = parseOrReply(z.object({
      status: z.enum(['draft', 'active', 'completed', 'archived']).optional()
    }), req.query, reply);
    if (!parsed) return;

    return {
      ok: true,
      seasons: tournamentStore.listSeasons(parsed.status)
    };
  });

  app.post('/seasons', async (req, reply) => {
    if (!requireRole(req, reply, 'operator')) return;

    const body = parseOrReply(z.object({
      name: z.string().min(3).max(120),
      description: z.string().max(500).optional(),
      status: z.enum(['draft', 'active', 'completed', 'archived']).optional(),
      startsAt: z.string().datetime().optional(),
      endsAt: z.string().datetime().optional(),
      metadata: z.record(z.string(), z.unknown()).optional()
    }), req.body, reply);
    if (!body) return;

    const season = tournamentStore.createSeason(body);
    return reply.code(201).send({ ok: true, season });
  });

  app.patch('/seasons/:id', async (req, reply) => {
    if (!requireRole(req, reply, 'operator')) return;

    const id = (req.params as { id: string }).id;
    const patch = parseOrReply(z.object({
      name: z.string().min(3).max(120).optional(),
      description: z.string().max(500).optional(),
      status: z.enum(['draft', 'active', 'completed', 'archived']).optional(),
      startsAt: z.string().datetime().optional(),
      endsAt: z.string().datetime().optional(),
      metadata: z.record(z.string(), z.unknown()).optional()
    }), req.body, reply);
    if (!patch) return;

    const updated = tournamentStore.patchSeason(id, patch);
    if (!updated) return reply.code(404).send({ error: 'not_found' });
    return { ok: true, season: updated };
  });

  app.get('/tournaments', async (req, reply) => {
    if (!requireRole(req, reply, 'readonly')) return;

    const parsed = parseOrReply(z.object({
      status: z.enum(['draft', 'active', 'completed', 'cancelled']).optional(),
      seasonId: z.string().optional()
    }), req.query, reply);
    if (!parsed) return;

    return {
      ok: true,
      tournaments: tournamentStore.listTournaments({
        status: parsed.status,
        seasonId: parsed.seasonId
      })
    };
  });

  app.get('/tournaments/:id', async (req, reply) => {
    if (!requireRole(req, reply, 'readonly')) return;

    const id = (req.params as { id: string }).id;
    const details = tournamentDetails(id);
    if (!details) return reply.code(404).send({ error: 'not_found' });

    return {
      ok: true,
      ...details
    };
  });

  app.post('/tournaments', async (req, reply) => {
    if (!requireRole(req, reply, 'operator')) return;

    const body = parseOrReply(z.object({
      seasonId: z.string().optional(),
      name: z.string().min(3).max(140),
      participantAgentIds: z.array(z.string().min(1)).min(2).max(128),
      challengeTemplate: z.object({
        config: configSchema.partial().optional(),
        stake: stakeSchema.optional(),
        notesPrefix: z.string().max(180).optional()
      }).optional(),
      status: z.enum(['draft', 'active', 'completed', 'cancelled']).optional(),
      metadata: z.record(z.string(), z.unknown()).optional()
    }), req.body, reply);
    if (!body) return;

    for (const agentId of body.participantAgentIds) {
      const agent = store.getAgent(agentId);
      if (!agent || !agent.enabled) {
        return reply.code(400).send({
          error: 'invalid_participant_agent',
          agentId
        });
      }
    }

    const challengeTemplate = {
      config: configSchema.parse({
        ...DEFAULT_CONFIG,
        ...(body.challengeTemplate?.config || {})
      }),
      stake: body.challengeTemplate?.stake || { mode: 'none' as const },
      notesPrefix: body.challengeTemplate?.notesPrefix
    };

    try {
      const tournament = tournamentStore.createTournament({
        seasonId: body.seasonId,
        name: body.name,
        participantAgentIds: body.participantAgentIds,
        challengeTemplate,
        status: body.status as TournamentStatus | undefined,
        metadata: body.metadata
      });

      const details = tournamentDetails(tournament.id);
      return reply.code(201).send({ ok: true, ...details });
    } catch (error) {
      return reply.code(400).send({
        error: 'tournament_create_failed',
        message: error instanceof Error ? error.message : 'unknown_error'
      });
    }
  });

  app.post('/tournaments/:id/start', async (req, reply) => {
    if (!requireRole(req, reply, 'operator')) return;

    const id = (req.params as { id: string }).id;
    const tournament = tournamentStore.getTournament(id);
    if (!tournament) return reply.code(404).send({ error: 'not_found' });

    if (tournament.status === 'completed' || tournament.status === 'cancelled') {
      return reply.code(400).send({
        error: 'invalid_status',
        status: tournament.status
      });
    }

    const body = parseOrReply(z.object({
      roundNumber: z.number().int().min(1).optional(),
      syncBeforeStart: z.boolean().optional()
    }), req.body || {}, reply);
    if (!body) return;

    if (body.syncBeforeStart !== false) {
      syncFixturesFromChallenges(id);
    }

    const updatedTournament = tournamentStore.patchTournament(id, { status: 'active' });
    if (!updatedTournament) return reply.code(404).send({ error: 'not_found' });

    const roundNumber = body.roundNumber ?? resolveNextRoundToLaunch(id);
    if (!roundNumber) {
      return {
        ok: true,
        tournament: updatedTournament,
        launch: {
          roundNumber: null,
          createdChallenges: [],
          skippedFixtures: []
        },
        sync: { synced: 0, skipped: 0 }
      };
    }

    const launch = launchRoundFixtures({
      tournament: updatedTournament,
      roundNumber
    });

    const details = tournamentDetails(id);
    return {
      ok: true,
      ...details,
      launch
    };
  });

  app.post('/tournaments/:id/sync', async (req, reply) => {
    if (!requireRole(req, reply, 'operator')) return;

    const id = (req.params as { id: string }).id;
    const tournament = tournamentStore.getTournament(id);
    if (!tournament) return reply.code(404).send({ error: 'not_found' });

    const body = parseOrReply(z.object({
      launchReady: z.boolean().optional()
    }), req.body || {}, reply);
    if (!body) return;

    const sync = syncFixturesFromChallenges(id);

    let launch: ReturnType<typeof launchRoundFixtures> | null = null;
    if (body.launchReady) {
      const refreshed = tournamentStore.getTournament(id);
      if (refreshed) {
        const nextRound = resolveNextRoundToLaunch(id);
        if (nextRound) {
          launch = launchRoundFixtures({
            tournament: refreshed,
            roundNumber: nextRound
          });
        }
      }
    }

    const details = tournamentDetails(id);

    return {
      ok: true,
      ...details,
      sync,
      launch
    };
  });
}
