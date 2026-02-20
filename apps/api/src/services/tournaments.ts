import { randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import Database from 'better-sqlite3';
import {
  MatchConfig,
  SeasonRecord,
  SeasonStatus,
  TournamentChallengeTemplate,
  TournamentFixtureRecord,
  TournamentFixtureStatus,
  TournamentFormat,
  TournamentRecord,
  TournamentRoundRecord,
  TournamentRoundStatus,
  TournamentStatus
} from '../types/domain.js';

const dbFile = resolve(process.cwd(), process.env.TOURNAMENT_DB_FILE || '.data/moltcombat-tournaments.sqlite');
mkdirSync(dirname(dbFile), { recursive: true });

const db = new Database(dbFile);
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');

db.exec(`
CREATE TABLE IF NOT EXISTS seasons (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL,
  starts_at TEXT,
  ends_at TEXT,
  metadata_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tournaments (
  id TEXT PRIMARY KEY,
  season_id TEXT,
  name TEXT NOT NULL,
  format TEXT NOT NULL,
  status TEXT NOT NULL,
  participant_agent_ids_json TEXT NOT NULL,
  challenge_template_json TEXT NOT NULL,
  champion_agent_id TEXT,
  metadata_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tournament_rounds (
  id TEXT PRIMARY KEY,
  tournament_id TEXT NOT NULL,
  round_number INTEGER NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(tournament_id, round_number)
);

CREATE TABLE IF NOT EXISTS tournament_fixtures (
  id TEXT PRIMARY KEY,
  tournament_id TEXT NOT NULL,
  round_number INTEGER NOT NULL,
  slot_number INTEGER NOT NULL,
  status TEXT NOT NULL,
  agent_a_id TEXT,
  agent_b_id TEXT,
  challenge_id TEXT,
  match_id TEXT,
  winner_agent_id TEXT,
  notes TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(tournament_id, round_number, slot_number)
);

CREATE INDEX IF NOT EXISTS idx_seasons_status ON seasons(status, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_tournaments_status ON tournaments(status, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_tournaments_season ON tournaments(season_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_tournament_rounds_tournament ON tournament_rounds(tournament_id, round_number);
CREATE INDEX IF NOT EXISTS idx_tournament_fixtures_tournament_round ON tournament_fixtures(tournament_id, round_number, slot_number);
CREATE INDEX IF NOT EXISTS idx_tournament_fixtures_challenge ON tournament_fixtures(challenge_id);
`);

function nowIso() {
  return new Date().toISOString();
}

function parseJson<T>(value: unknown, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(String(value)) as T;
  } catch {
    return fallback;
  }
}

function appendNote(existing: string | undefined, note: string): string {
  return [existing, note].filter(Boolean).join('\n');
}

function ensureStatus<T extends string>(value: string, allowed: readonly T[], fallback: T): T {
  return (allowed as readonly string[]).includes(value) ? (value as T) : fallback;
}

function toSeason(row: Record<string, unknown>): SeasonRecord {
  return {
    id: String(row.id),
    name: String(row.name),
    description: row.description ? String(row.description) : undefined,
    status: ensureStatus(String(row.status), ['draft', 'active', 'completed', 'archived'] as const, 'draft'),
    startsAt: row.starts_at ? String(row.starts_at) : undefined,
    endsAt: row.ends_at ? String(row.ends_at) : undefined,
    metadata: row.metadata_json ? parseJson<Record<string, unknown>>(String(row.metadata_json), {}) : undefined,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at)
  };
}

function toTournament(row: Record<string, unknown>): TournamentRecord {
  return {
    id: String(row.id),
    seasonId: row.season_id ? String(row.season_id) : undefined,
    name: String(row.name),
    format: ensureStatus(String(row.format), ['single_elimination'] as const, 'single_elimination'),
    status: ensureStatus(String(row.status), ['draft', 'active', 'completed', 'cancelled'] as const, 'draft'),
    participantAgentIds: parseJson<string[]>(String(row.participant_agent_ids_json), []),
    challengeTemplate: parseJson<TournamentChallengeTemplate>(String(row.challenge_template_json), {
      config: { maxTurns: 30, seed: 1, attackCost: 1, attackDamage: 4 },
      stake: { mode: 'none' }
    }),
    championAgentId: row.champion_agent_id ? String(row.champion_agent_id) : undefined,
    metadata: row.metadata_json ? parseJson<Record<string, unknown>>(String(row.metadata_json), {}) : undefined,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at)
  };
}

function toRound(row: Record<string, unknown>): TournamentRoundRecord {
  return {
    id: String(row.id),
    tournamentId: String(row.tournament_id),
    roundNumber: Number(row.round_number),
    status: ensureStatus(String(row.status), ['pending', 'active', 'completed'] as const, 'pending'),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at)
  };
}

function toFixture(row: Record<string, unknown>): TournamentFixtureRecord {
  return {
    id: String(row.id),
    tournamentId: String(row.tournament_id),
    roundNumber: Number(row.round_number),
    slotNumber: Number(row.slot_number),
    status: ensureStatus(String(row.status), ['pending', 'ready', 'running', 'completed', 'cancelled'] as const, 'pending'),
    agentAId: row.agent_a_id ? String(row.agent_a_id) : undefined,
    agentBId: row.agent_b_id ? String(row.agent_b_id) : undefined,
    challengeId: row.challenge_id ? String(row.challenge_id) : undefined,
    matchId: row.match_id ? String(row.match_id) : undefined,
    winnerAgentId: row.winner_agent_id ? String(row.winner_agent_id) : undefined,
    notes: row.notes ? String(row.notes) : undefined,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at)
  };
}

function nextId(prefix: string) {
  return `${prefix}_${Date.now()}_${randomBytes(2).toString('hex')}`;
}

function uniqueParticipants(input: string[]): string[] {
  return [...new Set(input.map((value) => value.trim()).filter(Boolean))];
}

function bracketSize(participants: number): number {
  let size = 1;
  while (size < participants) size *= 2;
  return Math.max(size, 2);
}

function roundCount(participants: number): number {
  return Math.max(1, Math.ceil(Math.log2(bracketSize(participants))));
}

function insertRound(params: {
  id: string;
  tournamentId: string;
  roundNumber: number;
  status: TournamentRoundStatus;
  now: string;
}) {
  db.prepare(`
    INSERT INTO tournament_rounds (id, tournament_id, round_number, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    params.id,
    params.tournamentId,
    params.roundNumber,
    params.status,
    params.now,
    params.now
  );
}

function insertFixture(params: {
  id: string;
  tournamentId: string;
  roundNumber: number;
  slotNumber: number;
  status: TournamentFixtureStatus;
  agentAId?: string;
  agentBId?: string;
  challengeId?: string;
  matchId?: string;
  winnerAgentId?: string;
  notes?: string;
  now: string;
}) {
  db.prepare(`
    INSERT INTO tournament_fixtures (
      id, tournament_id, round_number, slot_number, status,
      agent_a_id, agent_b_id, challenge_id, match_id, winner_agent_id, notes,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    params.id,
    params.tournamentId,
    params.roundNumber,
    params.slotNumber,
    params.status,
    params.agentAId ?? null,
    params.agentBId ?? null,
    params.challengeId ?? null,
    params.matchId ?? null,
    params.winnerAgentId ?? null,
    params.notes ?? null,
    params.now,
    params.now
  );
}

function updateFixture(fixture: TournamentFixtureRecord): TournamentFixtureRecord {
  const updatedAt = nowIso();
  db.prepare(`
    UPDATE tournament_fixtures SET
      status = ?,
      agent_a_id = ?,
      agent_b_id = ?,
      challenge_id = ?,
      match_id = ?,
      winner_agent_id = ?,
      notes = ?,
      updated_at = ?
    WHERE id = ?
  `).run(
    fixture.status,
    fixture.agentAId ?? null,
    fixture.agentBId ?? null,
    fixture.challengeId ?? null,
    fixture.matchId ?? null,
    fixture.winnerAgentId ?? null,
    fixture.notes ?? null,
    updatedAt,
    fixture.id
  );

  return tournamentStore.getTournamentFixture(fixture.id)!;
}

function updateRoundStatus(round: TournamentRoundRecord, status: TournamentRoundStatus): TournamentRoundRecord {
  if (round.status === status) return round;

  const updatedAt = nowIso();
  db.prepare('UPDATE tournament_rounds SET status = ?, updated_at = ? WHERE id = ?')
    .run(status, updatedAt, round.id);

  return tournamentStore.getTournamentRound(round.id)!;
}

function finalizeTournamentStatus(tournamentId: string) {
  const tournament = tournamentStore.getTournament(tournamentId);
  if (!tournament) return;

  const rounds = tournamentStore.listTournamentRounds(tournamentId);
  if (rounds.length === 0) return;

  const finalRound = rounds[rounds.length - 1];
  const finalFixtures = tournamentStore.listTournamentFixtures(tournamentId, finalRound.roundNumber);

  const completedFinal = finalFixtures.length > 0 && finalFixtures.every((fixture) => fixture.status === 'completed' && Boolean(fixture.winnerAgentId));
  if (!completedFinal) return;

  const championAgentId = finalFixtures[0].winnerAgentId;
  if (!championAgentId) return;

  tournamentStore.patchTournament(tournamentId, {
    status: 'completed',
    championAgentId
  });
}

function syncRoundStatuses(tournamentId: string) {
  const rounds = tournamentStore.listTournamentRounds(tournamentId);

  for (const round of rounds) {
    const fixtures = tournamentStore.listTournamentFixtures(tournamentId, round.roundNumber);
    const allPending = fixtures.every((fixture) => fixture.status === 'pending');
    const allCompleted = fixtures.length > 0 && fixtures.every((fixture) => fixture.status === 'completed' || fixture.status === 'cancelled');

    if (allCompleted) {
      updateRoundStatus(round, 'completed');
      continue;
    }

    if (!allPending) {
      updateRoundStatus(round, 'active');
      continue;
    }

    updateRoundStatus(round, 'pending');
  }
}

function propagateWinners(tournamentId: string): void {
  const rounds = tournamentStore.listTournamentRounds(tournamentId).sort((a, b) => a.roundNumber - b.roundNumber);
  if (rounds.length <= 1) {
    syncRoundStatuses(tournamentId);
    finalizeTournamentStatus(tournamentId);
    return;
  }

  let changed = true;
  while (changed) {
    changed = false;

    for (let index = 0; index < rounds.length - 1; index += 1) {
      const currentRound = rounds[index];
      const nextRound = rounds[index + 1];

      const currentFixtures = tournamentStore.listTournamentFixtures(tournamentId, currentRound.roundNumber)
        .sort((a, b) => a.slotNumber - b.slotNumber);
      const nextFixtures = tournamentStore.listTournamentFixtures(tournamentId, nextRound.roundNumber)
        .sort((a, b) => a.slotNumber - b.slotNumber);

      const nextBySlot = new Map<number, TournamentFixtureRecord>(nextFixtures.map((fixture) => [fixture.slotNumber, fixture]));
      const currentBySlot = new Map<number, TournamentFixtureRecord>(currentFixtures.map((fixture) => [fixture.slotNumber, fixture]));

      for (const fixture of currentFixtures) {
        if (!fixture.winnerAgentId) continue;

        const targetSlot = Math.ceil(fixture.slotNumber / 2);
        const target = nextBySlot.get(targetSlot);
        if (!target) continue;

        const isLeft = fixture.slotNumber % 2 === 1;
        const nextFixture = { ...target };

        if (isLeft && nextFixture.agentAId !== fixture.winnerAgentId) {
          nextFixture.agentAId = fixture.winnerAgentId;
          changed = true;
        }

        if (!isLeft && nextFixture.agentBId !== fixture.winnerAgentId) {
          nextFixture.agentBId = fixture.winnerAgentId;
          changed = true;
        }

        if (nextFixture.status === 'pending' && nextFixture.agentAId && nextFixture.agentBId) {
          nextFixture.status = 'ready';
          changed = true;
        }

        updateFixture(nextFixture);
      }

      const refreshedNext = tournamentStore.listTournamentFixtures(tournamentId, nextRound.roundNumber)
        .sort((a, b) => a.slotNumber - b.slotNumber);

      for (const fixture of refreshedNext) {
        if (fixture.winnerAgentId) continue;

        const prevLeft = currentBySlot.get((fixture.slotNumber * 2) - 1);
        const prevRight = currentBySlot.get(fixture.slotNumber * 2);

        const prevResolved = [prevLeft, prevRight].every((item) => !item || item.status === 'completed' || item.status === 'cancelled');
        if (!prevResolved) continue;

        const singleAgent = fixture.agentAId && !fixture.agentBId
          ? fixture.agentAId
          : fixture.agentBId && !fixture.agentAId
            ? fixture.agentBId
            : undefined;

        if (!singleAgent) continue;

        const autoCompleted = updateFixture({
          ...fixture,
          status: 'completed',
          winnerAgentId: singleAgent,
          notes: appendNote(fixture.notes, `bye_auto_advance:${new Date().toISOString()}`)
        });

        if (autoCompleted.winnerAgentId) {
          changed = true;
        }
      }
    }
  }

  syncRoundStatuses(tournamentId);
  finalizeTournamentStatus(tournamentId);
}

export const tournamentStore = {
  createSeason(input: {
    id?: string;
    name: string;
    description?: string;
    status?: SeasonStatus;
    startsAt?: string;
    endsAt?: string;
    metadata?: Record<string, unknown>;
  }): SeasonRecord {
    const id = input.id || nextId('season');
    const now = nowIso();

    db.prepare(`
      INSERT INTO seasons (id, name, description, status, starts_at, ends_at, metadata_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      input.name,
      input.description ?? null,
      input.status || 'draft',
      input.startsAt ?? null,
      input.endsAt ?? null,
      input.metadata ? JSON.stringify(input.metadata) : null,
      now,
      now
    );

    return tournamentStore.getSeason(id)!;
  },

  listSeasons(status?: SeasonStatus): SeasonRecord[] {
    const rows = (
      status
        ? db.prepare('SELECT * FROM seasons WHERE status = ? ORDER BY updated_at DESC').all(status)
        : db.prepare('SELECT * FROM seasons ORDER BY updated_at DESC').all()
    ) as Record<string, unknown>[];

    return rows.map(toSeason);
  },

  getSeason(id: string): SeasonRecord | undefined {
    const row = db.prepare('SELECT * FROM seasons WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    return row ? toSeason(row) : undefined;
  },

  patchSeason(id: string, patch: Partial<Omit<SeasonRecord, 'id' | 'createdAt'>>): SeasonRecord | undefined {
    const existing = tournamentStore.getSeason(id);
    if (!existing) return undefined;

    const next: SeasonRecord = {
      ...existing,
      ...patch,
      id,
      updatedAt: nowIso()
    };

    db.prepare(`
      UPDATE seasons SET
        name = ?,
        description = ?,
        status = ?,
        starts_at = ?,
        ends_at = ?,
        metadata_json = ?,
        updated_at = ?
      WHERE id = ?
    `).run(
      next.name,
      next.description ?? null,
      next.status,
      next.startsAt ?? null,
      next.endsAt ?? null,
      next.metadata ? JSON.stringify(next.metadata) : null,
      next.updatedAt,
      id
    );

    return tournamentStore.getSeason(id);
  },

  createTournament(input: {
    id?: string;
    seasonId?: string;
    name: string;
    participantAgentIds: string[];
    challengeTemplate: TournamentChallengeTemplate;
    format?: TournamentFormat;
    metadata?: Record<string, unknown>;
    status?: TournamentStatus;
  }): TournamentRecord {
    const participants = uniqueParticipants(input.participantAgentIds);
    if (participants.length < 2) {
      throw new Error('tournament_requires_minimum_two_participants');
    }

    const format = input.format || 'single_elimination';
    if (format !== 'single_elimination') {
      throw new Error('unsupported_tournament_format');
    }

    const id = input.id || nextId('tournament');
    const now = nowIso();
    const bracketParticipants = bracketSize(participants.length);
    const padded = [...participants, ...Array.from({ length: bracketParticipants - participants.length }, () => undefined)];
    const rounds = roundCount(participants.length);

    const tx = db.transaction(() => {
      db.prepare(`
        INSERT INTO tournaments (
          id, season_id, name, format, status,
          participant_agent_ids_json, challenge_template_json,
          champion_agent_id, metadata_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id,
        input.seasonId ?? null,
        input.name,
        format,
        input.status || 'draft',
        JSON.stringify(participants),
        JSON.stringify(input.challengeTemplate),
        null,
        input.metadata ? JSON.stringify(input.metadata) : null,
        now,
        now
      );

      for (let round = 1; round <= rounds; round += 1) {
        insertRound({
          id: nextId('round'),
          tournamentId: id,
          roundNumber: round,
          status: 'pending',
          now
        });

        const slots = bracketParticipants / (2 ** round);
        for (let slot = 1; slot <= slots; slot += 1) {
          if (round === 1) {
            const a = padded[(slot - 1) * 2];
            const b = padded[((slot - 1) * 2) + 1];

            const status: TournamentFixtureStatus = a && b
              ? 'ready'
              : (a || b)
                ? 'completed'
                : 'pending';

            const winnerAgentId = status === 'completed' ? (a || b) : undefined;
            const notes = status === 'completed' && winnerAgentId
              ? `bye_auto_advance:${now}`
              : undefined;

            insertFixture({
              id: nextId('fixture'),
              tournamentId: id,
              roundNumber: round,
              slotNumber: slot,
              status,
              agentAId: a,
              agentBId: b,
              winnerAgentId,
              notes,
              now
            });
          } else {
            insertFixture({
              id: nextId('fixture'),
              tournamentId: id,
              roundNumber: round,
              slotNumber: slot,
              status: 'pending',
              now
            });
          }
        }
      }
    });

    tx();
    propagateWinners(id);
    return tournamentStore.getTournament(id)!;
  },

  listTournaments(filter?: { status?: TournamentStatus; seasonId?: string }): TournamentRecord[] {
    const clauses: string[] = [];
    const values: string[] = [];

    if (filter?.status) {
      clauses.push('status = ?');
      values.push(filter.status);
    }

    if (filter?.seasonId) {
      clauses.push('season_id = ?');
      values.push(filter.seasonId);
    }

    const sql = `SELECT * FROM tournaments${clauses.length ? ` WHERE ${clauses.join(' AND ')}` : ''} ORDER BY updated_at DESC`;
    const rows = db.prepare(sql).all(...values) as Record<string, unknown>[];
    return rows.map(toTournament);
  },

  getTournament(id: string): TournamentRecord | undefined {
    const row = db.prepare('SELECT * FROM tournaments WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    return row ? toTournament(row) : undefined;
  },

  patchTournament(id: string, patch: Partial<Omit<TournamentRecord, 'id' | 'createdAt'>>): TournamentRecord | undefined {
    const existing = tournamentStore.getTournament(id);
    if (!existing) return undefined;

    const next: TournamentRecord = {
      ...existing,
      ...patch,
      id,
      updatedAt: nowIso(),
      participantAgentIds: patch.participantAgentIds ?? existing.participantAgentIds,
      challengeTemplate: patch.challengeTemplate ?? existing.challengeTemplate
    };

    db.prepare(`
      UPDATE tournaments SET
        season_id = ?,
        name = ?,
        format = ?,
        status = ?,
        participant_agent_ids_json = ?,
        challenge_template_json = ?,
        champion_agent_id = ?,
        metadata_json = ?,
        updated_at = ?
      WHERE id = ?
    `).run(
      next.seasonId ?? null,
      next.name,
      next.format,
      next.status,
      JSON.stringify(next.participantAgentIds),
      JSON.stringify(next.challengeTemplate),
      next.championAgentId ?? null,
      next.metadata ? JSON.stringify(next.metadata) : null,
      next.updatedAt,
      id
    );

    return tournamentStore.getTournament(id);
  },

  listTournamentRounds(tournamentId: string): TournamentRoundRecord[] {
    const rows = db.prepare(
      'SELECT * FROM tournament_rounds WHERE tournament_id = ? ORDER BY round_number ASC'
    ).all(tournamentId) as Record<string, unknown>[];

    return rows.map(toRound);
  },

  getTournamentRound(id: string): TournamentRoundRecord | undefined {
    const row = db.prepare('SELECT * FROM tournament_rounds WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    return row ? toRound(row) : undefined;
  },

  listTournamentFixtures(tournamentId: string, roundNumber?: number): TournamentFixtureRecord[] {
    const rows = (
      typeof roundNumber === 'number'
        ? db.prepare('SELECT * FROM tournament_fixtures WHERE tournament_id = ? AND round_number = ? ORDER BY slot_number ASC').all(tournamentId, roundNumber)
        : db.prepare('SELECT * FROM tournament_fixtures WHERE tournament_id = ? ORDER BY round_number ASC, slot_number ASC').all(tournamentId)
    ) as Record<string, unknown>[];

    return rows.map(toFixture);
  },

  getTournamentFixture(id: string): TournamentFixtureRecord | undefined {
    const row = db.prepare('SELECT * FROM tournament_fixtures WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    return row ? toFixture(row) : undefined;
  },

  findTournamentFixtureByChallengeId(challengeId: string): TournamentFixtureRecord | undefined {
    const row = db.prepare('SELECT * FROM tournament_fixtures WHERE challenge_id = ?').get(challengeId) as Record<string, unknown> | undefined;
    return row ? toFixture(row) : undefined;
  },

  patchTournamentFixture(id: string, patch: Partial<Omit<TournamentFixtureRecord, 'id' | 'tournamentId' | 'roundNumber' | 'slotNumber' | 'createdAt'>>): TournamentFixtureRecord | undefined {
    const existing = tournamentStore.getTournamentFixture(id);
    if (!existing) return undefined;

    const next: TournamentFixtureRecord = {
      ...existing,
      ...patch,
      id,
      tournamentId: existing.tournamentId,
      roundNumber: existing.roundNumber,
      slotNumber: existing.slotNumber,
      createdAt: existing.createdAt,
      updatedAt: nowIso()
    };

    return updateFixture(next);
  },

  propagateTournament(tournamentId: string): TournamentRecord | undefined {
    const tournament = tournamentStore.getTournament(tournamentId);
    if (!tournament) return undefined;

    propagateWinners(tournamentId);
    return tournamentStore.getTournament(tournamentId);
  },

  syncFixtureFromChallenge(params: {
    tournamentId: string;
    fixtureId: string;
    challengeId: string;
    challengeStatus: string;
    challengeMatchId?: string;
    challengeWinnerAgentId?: string;
  }): TournamentFixtureRecord | undefined {
    const fixture = tournamentStore.getTournamentFixture(params.fixtureId);
    if (!fixture || fixture.tournamentId !== params.tournamentId) return undefined;

    const status: TournamentFixtureStatus = params.challengeStatus === 'completed'
      ? 'completed'
      : params.challengeStatus === 'cancelled'
        ? 'cancelled'
        : 'running';

    const updated = tournamentStore.patchTournamentFixture(fixture.id, {
      challengeId: params.challengeId,
      matchId: params.challengeMatchId,
      winnerAgentId: params.challengeWinnerAgentId,
      status,
      notes: status === 'completed' && params.challengeWinnerAgentId
        ? appendNote(fixture.notes, `winner_recorded:${new Date().toISOString()}:${params.challengeWinnerAgentId}`)
        : fixture.notes
    });

    if (!updated) return undefined;

    tournamentStore.propagateTournament(params.tournamentId);
    return tournamentStore.getTournamentFixture(fixture.id);
  },

  dbFile
};
