import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import Database from 'better-sqlite3';
import {
  AgentAction,
  AgentInstallInvite,
  AgentProfile,
  AutomationRunRecord,
  BettingMarketRecord,
  ChallengeRecord,
  ChallengeStake,
  ChallengeStatus,
  MarketPositionRecord,
  MarketPayout,
  MarketStatus,
  MarketSubjectType,
  MatchAttestationRecord,
  MatchAuditRecord,
  MatchConfig,
  MatchRecord
} from '../types/domain.js';

export type AgentHealthStatus = 'unknown' | 'healthy' | 'unhealthy';

export type RegisteredAgent = AgentProfile & {
  enabled: boolean;
  metadata?: Record<string, unknown>;
  lastHealthStatus: AgentHealthStatus;
  lastHealthError?: string;
  lastHealthAt?: string;
  createdAt: string;
  updatedAt: string;
};

type AgentUpsertInput = AgentProfile & {
  enabled?: boolean;
  metadata?: Record<string, unknown>;
};

type ChallengeUpsertInput = {
  id?: string;
  topic: string;
  challengerAgentId: string;
  opponentAgentId?: string;
  config: MatchConfig;
  stake?: ChallengeStake;
  notes?: string;
  status?: ChallengeStatus;
};

type ChallengePatch = Partial<Omit<ChallengeRecord, 'id' | 'createdAt'>>;

type ChallengeRoundSubmissionInput = {
  challengeId: string;
  turn: number;
  agentId: string;
  action: AgentAction;
};

type MarketCreateInput = {
  id?: string;
  subjectType: MarketSubjectType;
  subjectId: string;
  outcomes: string[];
  feeBps?: number;
  metadata?: Record<string, unknown>;
};

type MarketFilter = {
  status?: MarketStatus;
  subjectType?: MarketSubjectType;
  subjectId?: string;
};

type MarketBetInput = {
  marketId: string;
  bettor: string;
  outcome: string;
  amount: string;
};

type MarketResolveInput = {
  resultOutcome: string;
  payouts: MarketPayout[];
  totalPool: string;
  feeAmount: string;
  payoutPool: string;
};

type AutomationRunInput = {
  automationType: AutomationRunRecord['automationType'];
  status: AutomationRunRecord['status'];
  startedAt: string;
  finishedAt: string;
  summary: Record<string, unknown>;
};

const dbFile = resolve(process.cwd(), process.env.MATCH_DB_FILE || '.data/moltcombat.sqlite');
mkdirSync(dirname(dbFile), { recursive: true });

const db = new Database(dbFile);
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');

db.exec(`
CREATE TABLE IF NOT EXISTS matches (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  started_at TEXT NOT NULL,
  turns_played INTEGER NOT NULL,
  winner TEXT,
  scorecard_hash TEXT,
  agents_json TEXT NOT NULL,
  replay_json TEXT NOT NULL,
  config_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS match_audits (
  match_id TEXT PRIMARY KEY,
  audit_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (match_id) REFERENCES matches(id)
);

CREATE TABLE IF NOT EXISTS match_attestations (
  match_id TEXT PRIMARY KEY,
  signer_address TEXT NOT NULL,
  signature TEXT NOT NULL,
  signature_type TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (match_id) REFERENCES matches(id)
);

CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  endpoint TEXT NOT NULL,
  api_key TEXT,
  payout_address TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  metadata_json TEXT,
  last_health_status TEXT NOT NULL DEFAULT 'unknown',
  last_health_error TEXT,
  last_health_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS challenges (
  id TEXT PRIMARY KEY,
  topic TEXT NOT NULL,
  status TEXT NOT NULL,
  challenger_agent_id TEXT NOT NULL,
  opponent_agent_id TEXT,
  config_json TEXT NOT NULL,
  stake_json TEXT NOT NULL,
  match_id TEXT,
  winner_agent_id TEXT,
  notes TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS betting_markets (
  id TEXT PRIMARY KEY,
  subject_type TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  status TEXT NOT NULL,
  outcomes_json TEXT NOT NULL,
  fee_bps INTEGER NOT NULL DEFAULT 0,
  total_pool TEXT NOT NULL DEFAULT '0',
  payout_pool TEXT NOT NULL DEFAULT '0',
  fee_amount TEXT NOT NULL DEFAULT '0',
  result_outcome TEXT,
  payouts_json TEXT,
  metadata_json TEXT,
  created_at TEXT NOT NULL,
  locked_at TEXT,
  resolved_at TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS market_positions (
  id TEXT PRIMARY KEY,
  market_id TEXT NOT NULL,
  bettor TEXT NOT NULL,
  outcome TEXT NOT NULL,
  amount TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (market_id) REFERENCES betting_markets(id)
);

CREATE TABLE IF NOT EXISTS automation_runs (
  id TEXT PRIMARY KEY,
  automation_type TEXT NOT NULL,
  status TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT NOT NULL,
  summary_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS challenge_round_submissions (
  challenge_id TEXT NOT NULL,
  turn INTEGER NOT NULL,
  agent_id TEXT NOT NULL,
  action_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (challenge_id, turn, agent_id),
  FOREIGN KEY (challenge_id) REFERENCES challenges(id)
);

CREATE TABLE IF NOT EXISTS agent_install_invites (
  id TEXT PRIMARY KEY,
  token_hash TEXT UNIQUE NOT NULL,
  token_preview TEXT NOT NULL,
  note TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT,
  used_at TEXT,
  used_by_agent_id TEXT
);

CREATE INDEX IF NOT EXISTS idx_matches_started_at ON matches(started_at DESC);
CREATE INDEX IF NOT EXISTS idx_match_audits_updated ON match_audits(updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_match_attestations_created ON match_attestations(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_agents_enabled ON agents(enabled);
CREATE INDEX IF NOT EXISTS idx_agents_api_key ON agents(api_key);
CREATE INDEX IF NOT EXISTS idx_challenges_status_created ON challenges(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_markets_subject ON betting_markets(subject_type, subject_id);
CREATE INDEX IF NOT EXISTS idx_markets_status ON betting_markets(status, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_market_positions_market ON market_positions(market_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_market_positions_bettor ON market_positions(bettor, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_automation_runs_type ON automation_runs(automation_type, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_challenge_round_submissions_challenge ON challenge_round_submissions(challenge_id, turn);
CREATE INDEX IF NOT EXISTS idx_invites_created ON agent_install_invites(created_at DESC);
`);

function nowIso() {
  return new Date().toISOString();
}

function hashToken(token: string) {
  return createHash('sha256').update(token).digest('hex');
}

function parseJson<T>(value: unknown, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(String(value)) as T;
  } catch {
    return fallback;
  }
}

function toMatch(row: Record<string, unknown>): MatchRecord {
  return {
    id: String(row.id),
    status: row.status as MatchRecord['status'],
    startedAt: String(row.started_at),
    turnsPlayed: Number(row.turns_played),
    winner: row.winner ? String(row.winner) : undefined,
    scorecardHash: row.scorecard_hash ? String(row.scorecard_hash) : undefined,
    agents: parseJson(String(row.agents_json), []) as MatchRecord['agents'],
    replay: parseJson(String(row.replay_json), []) as MatchRecord['replay'],
    config: parseJson(String(row.config_json), {}) as MatchRecord['config']
  };
}

function toRegisteredAgent(row: Record<string, unknown>): RegisteredAgent {
  return {
    id: String(row.id),
    name: String(row.name),
    endpoint: String(row.endpoint),
    apiKey: row.api_key ? String(row.api_key) : undefined,
    payoutAddress: row.payout_address ? String(row.payout_address) : undefined,
    enabled: Number(row.enabled) === 1,
    metadata: row.metadata_json ? parseJson<Record<string, unknown>>(String(row.metadata_json), {}) : undefined,
    lastHealthStatus: (row.last_health_status as AgentHealthStatus) || 'unknown',
    lastHealthError: row.last_health_error ? String(row.last_health_error) : undefined,
    lastHealthAt: row.last_health_at ? String(row.last_health_at) : undefined,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at)
  };
}

function toChallenge(row: Record<string, unknown>): ChallengeRecord {
  return {
    id: String(row.id),
    topic: String(row.topic),
    status: row.status as ChallengeStatus,
    challengerAgentId: String(row.challenger_agent_id),
    opponentAgentId: row.opponent_agent_id ? String(row.opponent_agent_id) : undefined,
    config: parseJson<MatchConfig>(String(row.config_json), {} as MatchConfig),
    stake: parseJson<ChallengeStake>(String(row.stake_json), { mode: 'none' }),
    matchId: row.match_id ? String(row.match_id) : undefined,
    winnerAgentId: row.winner_agent_id ? String(row.winner_agent_id) : undefined,
    notes: row.notes ? String(row.notes) : undefined,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at)
  };
}

function toInvite(row: Record<string, unknown>): AgentInstallInvite {
  const expiresAt = row.expires_at ? String(row.expires_at) : undefined;
  const usedAt = row.used_at ? String(row.used_at) : undefined;
  const now = Date.now();

  const status: AgentInstallInvite['status'] = usedAt
    ? 'used'
    : expiresAt && Date.parse(expiresAt) <= now
      ? 'expired'
      : 'active';

  return {
    id: String(row.id),
    note: row.note ? String(row.note) : undefined,
    createdAt: String(row.created_at),
    expiresAt,
    usedAt,
    usedByAgentId: row.used_by_agent_id ? String(row.used_by_agent_id) : undefined,
    status,
    tokenPreview: String(row.token_preview)
  };
}

function toMatchAttestation(row: Record<string, unknown>): MatchAttestationRecord {
  return {
    matchId: String(row.match_id),
    signerAddress: String(row.signer_address),
    signature: String(row.signature),
    signatureType: String(row.signature_type) as MatchAttestationRecord['signatureType'],
    payloadHash: String(row.payload_hash),
    payload: parseJson(String(row.payload_json), {}) as MatchAttestationRecord['payload'],
    createdAt: String(row.created_at)
  };
}

function toMarket(row: Record<string, unknown>): BettingMarketRecord {
  return {
    id: String(row.id),
    subjectType: String(row.subject_type) as MarketSubjectType,
    subjectId: String(row.subject_id),
    status: String(row.status) as MarketStatus,
    outcomes: parseJson<string[]>(String(row.outcomes_json), []),
    feeBps: Number(row.fee_bps),
    totalPool: String(row.total_pool),
    payoutPool: String(row.payout_pool),
    feeAmount: String(row.fee_amount),
    resultOutcome: row.result_outcome ? String(row.result_outcome) : undefined,
    payouts: row.payouts_json ? parseJson<MarketPayout[]>(String(row.payouts_json), []) : undefined,
    metadata: row.metadata_json ? parseJson<Record<string, unknown>>(String(row.metadata_json), {}) : undefined,
    createdAt: String(row.created_at),
    lockedAt: row.locked_at ? String(row.locked_at) : undefined,
    resolvedAt: row.resolved_at ? String(row.resolved_at) : undefined,
    updatedAt: String(row.updated_at)
  };
}

function toMarketPosition(row: Record<string, unknown>): MarketPositionRecord {
  return {
    id: String(row.id),
    marketId: String(row.market_id),
    bettor: String(row.bettor),
    outcome: String(row.outcome),
    amount: String(row.amount),
    createdAt: String(row.created_at)
  };
}

function toAutomationRun(row: Record<string, unknown>): AutomationRunRecord {
  return {
    id: String(row.id),
    automationType: String(row.automation_type) as AutomationRunRecord['automationType'],
    status: String(row.status) as AutomationRunRecord['status'],
    startedAt: String(row.started_at),
    finishedAt: String(row.finished_at),
    summary: parseJson<Record<string, unknown>>(String(row.summary_json), {})
  };
}

function getMatchAudit(matchId: string): MatchAuditRecord | undefined {
  const row = db.prepare('SELECT audit_json FROM match_audits WHERE match_id = ?').get(matchId) as { audit_json: string } | undefined;
  if (!row) return undefined;
  return parseJson<MatchAuditRecord>(row.audit_json, undefined as unknown as MatchAuditRecord);
}

function listMatchAudits(matchIds: string[]): Map<string, MatchAuditRecord> {
  if (matchIds.length === 0) return new Map();

  const placeholders = matchIds.map(() => '?').join(',');
  const rows = db.prepare(`SELECT match_id, audit_json FROM match_audits WHERE match_id IN (${placeholders})`).all(...matchIds) as Array<{
    match_id: string;
    audit_json: string;
  }>;

  const map = new Map<string, MatchAuditRecord>();
  for (const row of rows) {
    map.set(row.match_id, parseJson<MatchAuditRecord>(row.audit_json, undefined as unknown as MatchAuditRecord));
  }
  return map;
}

function migrateLegacyJsonStoreIfNeeded() {
  const countRow = db.prepare('SELECT COUNT(*) as count FROM matches').get() as { count: number } | undefined;
  if ((countRow?.count ?? 0) > 0) return;

  const legacyFile = resolve(process.cwd(), process.env.MATCH_STORE_FILE || '.data/matches.json');
  if (!existsSync(legacyFile)) return;

  try {
    const raw = readFileSync(legacyFile, 'utf-8').trim();
    if (!raw) return;
    const legacyMatches = JSON.parse(raw);
    if (!Array.isArray(legacyMatches)) return;

    const upsert = db.prepare(`
      INSERT INTO matches (
        id, status, started_at, turns_played, winner, scorecard_hash,
        agents_json, replay_json, config_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        status=excluded.status,
        turns_played=excluded.turns_played,
        winner=excluded.winner,
        scorecard_hash=excluded.scorecard_hash,
        agents_json=excluded.agents_json,
        replay_json=excluded.replay_json,
        config_json=excluded.config_json,
        updated_at=excluded.updated_at
    `);

    const now = nowIso();
    const tx = db.transaction((items: MatchRecord[]) => {
      for (const item of items) {
        upsert.run(
          item.id,
          item.status,
          item.startedAt,
          item.turnsPlayed,
          item.winner ?? null,
          item.scorecardHash ?? null,
          JSON.stringify(item.agents ?? []),
          JSON.stringify(item.replay ?? []),
          JSON.stringify(item.config ?? {}),
          now,
          now
        );
      }
    });

    tx(legacyMatches as MatchRecord[]);
  } catch {
    // Ignore migration errors to keep startup non-blocking.
  }
}

migrateLegacyJsonStoreIfNeeded();

export const store = {
  listMatches(): MatchRecord[] {
    const rows = db.prepare('SELECT * FROM matches ORDER BY started_at DESC').all() as Record<string, unknown>[];
    const matches = rows.map(toMatch);
    const audits = listMatchAudits(matches.map((match) => match.id));
    return matches.map((match) => ({
      ...match,
      audit: audits.get(match.id)
    }));
  },

  getMatch(id: string): MatchRecord | undefined {
    const row = db.prepare('SELECT * FROM matches WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    if (!row) return undefined;

    const match = toMatch(row);
    match.audit = getMatchAudit(id);
    return match;
  },

  saveMatch(match: MatchRecord): void {
    const now = nowIso();
    db.prepare(`
      INSERT INTO matches (
        id, status, started_at, turns_played, winner, scorecard_hash,
        agents_json, replay_json, config_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        status=excluded.status,
        turns_played=excluded.turns_played,
        winner=excluded.winner,
        scorecard_hash=excluded.scorecard_hash,
        agents_json=excluded.agents_json,
        replay_json=excluded.replay_json,
        config_json=excluded.config_json,
        updated_at=excluded.updated_at
    `).run(
      match.id,
      match.status,
      match.startedAt,
      match.turnsPlayed,
      match.winner ?? null,
      match.scorecardHash ?? null,
      JSON.stringify(match.agents),
      JSON.stringify(match.replay),
      JSON.stringify(match.config),
      now,
      now
    );

    if (match.audit) {
      db.prepare(`
        INSERT INTO match_audits (match_id, audit_json, created_at, updated_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(match_id) DO UPDATE SET
          audit_json=excluded.audit_json,
          updated_at=excluded.updated_at
      `).run(
        match.id,
        JSON.stringify(match.audit),
        now,
        now
      );
    }
  },

  saveMatchAttestation(attestation: MatchAttestationRecord): void {
    const now = nowIso();
    db.prepare(`
      INSERT INTO match_attestations (
        match_id, signer_address, signature, signature_type,
        payload_hash, payload_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(match_id) DO UPDATE SET
        signer_address=excluded.signer_address,
        signature=excluded.signature,
        signature_type=excluded.signature_type,
        payload_hash=excluded.payload_hash,
        payload_json=excluded.payload_json,
        updated_at=excluded.updated_at
    `).run(
      attestation.matchId,
      attestation.signerAddress,
      attestation.signature,
      attestation.signatureType,
      attestation.payloadHash,
      JSON.stringify(attestation.payload),
      attestation.createdAt || now,
      now
    );
  },

  getMatchAttestation(matchId: string): MatchAttestationRecord | undefined {
    const row = db.prepare('SELECT * FROM match_attestations WHERE match_id = ?').get(matchId) as Record<string, unknown> | undefined;
    return row ? toMatchAttestation(row) : undefined;
  },

  listMatchAttestations(): MatchAttestationRecord[] {
    const rows = db.prepare('SELECT * FROM match_attestations ORDER BY created_at DESC').all() as Record<string, unknown>[];
    return rows.map(toMatchAttestation);
  },

  listAgents(includeDisabled = false): RegisteredAgent[] {
    const rows = db.prepare(
      includeDisabled
        ? 'SELECT * FROM agents ORDER BY updated_at DESC'
        : 'SELECT * FROM agents WHERE enabled = 1 ORDER BY updated_at DESC'
    ).all() as Record<string, unknown>[];
    return rows.map(toRegisteredAgent);
  },

  getAgent(id: string): RegisteredAgent | undefined {
    const row = db.prepare('SELECT * FROM agents WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    return row ? toRegisteredAgent(row) : undefined;
  },

  findAgentByApiKey(apiKey: string): RegisteredAgent | undefined {
    const normalized = apiKey.trim();
    if (!normalized) return undefined;

    const row = db.prepare('SELECT * FROM agents WHERE api_key = ? AND enabled = 1').get(normalized) as Record<string, unknown> | undefined;
    return row ? toRegisteredAgent(row) : undefined;
  },

  upsertAgent(agent: AgentUpsertInput): RegisteredAgent {
    const now = nowIso();
    const existing = store.getAgent(agent.id);

    db.prepare(`
      INSERT INTO agents (
        id, name, endpoint, api_key, payout_address, enabled, metadata_json,
        last_health_status, last_health_error, last_health_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name=excluded.name,
        endpoint=excluded.endpoint,
        api_key=excluded.api_key,
        payout_address=excluded.payout_address,
        enabled=excluded.enabled,
        metadata_json=excluded.metadata_json,
        updated_at=excluded.updated_at
    `).run(
      agent.id,
      agent.name,
      agent.endpoint,
      agent.apiKey ?? null,
      agent.payoutAddress ?? null,
      agent.enabled === false ? 0 : 1,
      agent.metadata ? JSON.stringify(agent.metadata) : null,
      existing?.lastHealthStatus ?? 'unknown',
      existing?.lastHealthError ?? null,
      existing?.lastHealthAt ?? null,
      existing?.createdAt ?? now,
      now
    );

    return store.getAgent(agent.id)!;
  },

  disableAgent(id: string): void {
    db.prepare('UPDATE agents SET enabled = 0, updated_at = ? WHERE id = ?').run(nowIso(), id);
  },

  setAgentHealth(params: { id: string; status: AgentHealthStatus; error?: string }): void {
    const now = nowIso();
    db.prepare(
      'UPDATE agents SET last_health_status = ?, last_health_error = ?, last_health_at = ?, updated_at = ? WHERE id = ?'
    ).run(
      params.status,
      params.error ?? null,
      now,
      now,
      params.id
    );
  },

  createChallenge(input: ChallengeUpsertInput): ChallengeRecord {
    const id = input.id || `challenge_${Date.now()}_${randomBytes(2).toString('hex')}`;
    const now = nowIso();
    const status = input.status || (input.opponentAgentId ? 'accepted' : 'open');

    db.prepare(`
      INSERT INTO challenges (
        id, topic, status, challenger_agent_id, opponent_agent_id,
        config_json, stake_json, match_id, winner_agent_id, notes,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      input.topic,
      status,
      input.challengerAgentId,
      input.opponentAgentId ?? null,
      JSON.stringify(input.config),
      JSON.stringify(input.stake ?? { mode: 'none' }),
      null,
      null,
      input.notes ?? null,
      now,
      now
    );

    return store.getChallenge(id)!;
  },

  listChallenges(status?: ChallengeStatus): ChallengeRecord[] {
    const rows = (
      status
        ? db.prepare('SELECT * FROM challenges WHERE status = ? ORDER BY created_at DESC').all(status)
        : db.prepare('SELECT * FROM challenges ORDER BY created_at DESC').all()
    ) as Record<string, unknown>[];

    return rows.map(toChallenge);
  },

  getChallenge(id: string): ChallengeRecord | undefined {
    const row = db.prepare('SELECT * FROM challenges WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    return row ? toChallenge(row) : undefined;
  },

  patchChallenge(id: string, patch: ChallengePatch): ChallengeRecord | undefined {
    const existing = store.getChallenge(id);
    if (!existing) return undefined;

    const next: ChallengeRecord = {
      ...existing,
      ...patch,
      id,
      config: patch.config ?? existing.config,
      stake: patch.stake ?? existing.stake,
      updatedAt: nowIso()
    };

    db.prepare(`
      UPDATE challenges SET
        topic = ?,
        status = ?,
        challenger_agent_id = ?,
        opponent_agent_id = ?,
        config_json = ?,
        stake_json = ?,
        match_id = ?,
        winner_agent_id = ?,
        notes = ?,
        updated_at = ?
      WHERE id = ?
    `).run(
      next.topic,
      next.status,
      next.challengerAgentId,
      next.opponentAgentId ?? null,
      JSON.stringify(next.config),
      JSON.stringify(next.stake),
      next.matchId ?? null,
      next.winnerAgentId ?? null,
      next.notes ?? null,
      next.updatedAt,
      id
    );

    return store.getChallenge(id);
  },

  upsertChallengeRoundSubmission(input: ChallengeRoundSubmissionInput): void {
    const now = nowIso();
    db.prepare(`
      INSERT INTO challenge_round_submissions (
        challenge_id, turn, agent_id, action_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(challenge_id, turn, agent_id) DO UPDATE SET
        action_json = excluded.action_json,
        updated_at = excluded.updated_at
    `).run(
      input.challengeId,
      input.turn,
      input.agentId,
      JSON.stringify(input.action),
      now,
      now
    );
  },

  getChallengeRoundSubmissions(challengeId: string, turn: number): Array<{
    challengeId: string;
    turn: number;
    agentId: string;
    action: AgentAction;
    createdAt: string;
    updatedAt: string;
  }> {
    const rows = db.prepare(`
      SELECT * FROM challenge_round_submissions
      WHERE challenge_id = ? AND turn = ?
      ORDER BY updated_at ASC
    `).all(challengeId, turn) as Record<string, unknown>[];

    return rows.map((row) => ({
      challengeId: String(row.challenge_id),
      turn: Number(row.turn),
      agentId: String(row.agent_id),
      action: parseJson<AgentAction>(row.action_json, { type: 'hold' }),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at)
    }));
  },

  clearChallengeRoundSubmissions(challengeId: string, turn?: number): void {
    if (typeof turn === 'number') {
      db.prepare('DELETE FROM challenge_round_submissions WHERE challenge_id = ? AND turn = ?').run(challengeId, turn);
      return;
    }

    db.prepare('DELETE FROM challenge_round_submissions WHERE challenge_id = ?').run(challengeId);
  },

  createMarket(input: MarketCreateInput): BettingMarketRecord {
    const now = nowIso();
    const id = input.id || `market_${Date.now()}_${randomBytes(2).toString('hex')}`;

    db.prepare(`
      INSERT INTO betting_markets (
        id, subject_type, subject_id, status, outcomes_json, fee_bps,
        total_pool, payout_pool, fee_amount, result_outcome, payouts_json,
        metadata_json, created_at, locked_at, resolved_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      input.subjectType,
      input.subjectId,
      'open',
      JSON.stringify(input.outcomes),
      input.feeBps ?? 0,
      '0',
      '0',
      '0',
      null,
      null,
      input.metadata ? JSON.stringify(input.metadata) : null,
      now,
      null,
      null,
      now
    );

    return store.getMarket(id)!;
  },

  listMarkets(filter?: MarketFilter): BettingMarketRecord[] {
    const clauses: string[] = [];
    const values: string[] = [];

    if (filter?.status) {
      clauses.push('status = ?');
      values.push(filter.status);
    }

    if (filter?.subjectType) {
      clauses.push('subject_type = ?');
      values.push(filter.subjectType);
    }

    if (filter?.subjectId) {
      clauses.push('subject_id = ?');
      values.push(filter.subjectId);
    }

    const sql = `SELECT * FROM betting_markets${clauses.length > 0 ? ` WHERE ${clauses.join(' AND ')}` : ''} ORDER BY updated_at DESC`;
    const rows = db.prepare(sql).all(...values) as Record<string, unknown>[];
    return rows.map(toMarket);
  },

  getMarket(id: string): BettingMarketRecord | undefined {
    const row = db.prepare('SELECT * FROM betting_markets WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    return row ? toMarket(row) : undefined;
  },

  placeMarketBet(input: MarketBetInput): MarketPositionRecord {
    const createdAt = nowIso();
    const positionId = `bet_${Date.now()}_${randomBytes(2).toString('hex')}`;

    const tx = db.transaction(() => {
      const marketRow = db.prepare('SELECT * FROM betting_markets WHERE id = ?').get(input.marketId) as Record<string, unknown> | undefined;
      if (!marketRow) throw new Error('market_not_found');

      const market = toMarket(marketRow);
      if (market.status !== 'open') throw new Error('market_not_open');
      if (!market.outcomes.includes(input.outcome)) throw new Error('invalid_outcome');

      let amount: bigint;
      try {
        amount = BigInt(input.amount);
      } catch {
        throw new Error('invalid_amount');
      }

      if (amount <= 0n) throw new Error('invalid_amount');

      db.prepare(`
        INSERT INTO market_positions (id, market_id, bettor, outcome, amount, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(positionId, input.marketId, input.bettor, input.outcome, amount.toString(), createdAt);

      const nextPool = (BigInt(market.totalPool) + amount).toString();
      db.prepare('UPDATE betting_markets SET total_pool = ?, updated_at = ? WHERE id = ?')
        .run(nextPool, createdAt, input.marketId);
    });

    tx();

    return store.getMarketPosition(positionId)!;
  },

  listMarketPositions(marketId: string): MarketPositionRecord[] {
    const rows = db.prepare('SELECT * FROM market_positions WHERE market_id = ? ORDER BY created_at ASC').all(marketId) as Record<string, unknown>[];
    return rows.map(toMarketPosition);
  },

  getMarketPosition(id: string): MarketPositionRecord | undefined {
    const row = db.prepare('SELECT * FROM market_positions WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    return row ? toMarketPosition(row) : undefined;
  },

  lockMarket(id: string): BettingMarketRecord | undefined {
    const existing = store.getMarket(id);
    if (!existing) return undefined;
    if (existing.status !== 'open') return existing;

    const now = nowIso();
    db.prepare('UPDATE betting_markets SET status = ?, locked_at = ?, updated_at = ? WHERE id = ?')
      .run('locked', now, now, id);

    return store.getMarket(id);
  },

  resolveMarket(id: string, input: MarketResolveInput): BettingMarketRecord | undefined {
    const existing = store.getMarket(id);
    if (!existing) return undefined;

    const now = nowIso();
    db.prepare(`
      UPDATE betting_markets SET
        status = ?,
        result_outcome = ?,
        payouts_json = ?,
        total_pool = ?,
        fee_amount = ?,
        payout_pool = ?,
        resolved_at = ?,
        updated_at = ?
      WHERE id = ?
    `).run(
      'resolved',
      input.resultOutcome,
      JSON.stringify(input.payouts),
      input.totalPool,
      input.feeAmount,
      input.payoutPool,
      now,
      now,
      id
    );

    return store.getMarket(id);
  },

  cancelMarket(id: string): BettingMarketRecord | undefined {
    const existing = store.getMarket(id);
    if (!existing) return undefined;

    const now = nowIso();
    db.prepare('UPDATE betting_markets SET status = ?, updated_at = ? WHERE id = ?')
      .run('cancelled', now, id);

    return store.getMarket(id);
  },

  recordAutomationRun(input: AutomationRunInput): AutomationRunRecord {
    const id = `auto_${Date.now()}_${randomBytes(2).toString('hex')}`;
    const createdAt = nowIso();

    db.prepare(`
      INSERT INTO automation_runs (
        id, automation_type, status, started_at, finished_at, summary_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      input.automationType,
      input.status,
      input.startedAt,
      input.finishedAt,
      JSON.stringify(input.summary),
      createdAt
    );

    return store.getAutomationRun(id)!;
  },

  listAutomationRuns(automationType?: AutomationRunRecord['automationType'], limit = 20): AutomationRunRecord[] {
    const safeLimit = Math.max(1, Math.min(limit, 200));
    const rows = (
      automationType
        ? db.prepare('SELECT * FROM automation_runs WHERE automation_type = ? ORDER BY started_at DESC LIMIT ?').all(automationType, safeLimit)
        : db.prepare('SELECT * FROM automation_runs ORDER BY started_at DESC LIMIT ?').all(safeLimit)
    ) as Record<string, unknown>[];

    return rows.map(toAutomationRun);
  },

  getAutomationRun(id: string): AutomationRunRecord | undefined {
    const row = db.prepare('SELECT * FROM automation_runs WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    return row ? toAutomationRun(row) : undefined;
  },

  createInstallInvite(params?: { note?: string; expiresInMinutes?: number }) {
    const id = `invite_${Date.now()}_${randomBytes(2).toString('hex')}`;
    const token = randomBytes(24).toString('hex');
    const tokenHash = hashToken(token);
    const tokenPreview = `${token.slice(0, 8)}...${token.slice(-4)}`;
    const now = nowIso();
    const expiresAt = params?.expiresInMinutes
      ? new Date(Date.now() + params.expiresInMinutes * 60_000).toISOString()
      : null;

    db.prepare(`
      INSERT INTO agent_install_invites (
        id, token_hash, token_preview, note, created_at, expires_at, used_at, used_by_agent_id
      ) VALUES (?, ?, ?, ?, ?, ?, NULL, NULL)
    `).run(
      id,
      tokenHash,
      tokenPreview,
      params?.note ?? null,
      now,
      expiresAt
    );

    return {
      token,
      invite: store.getInstallInvite(id)!
    };
  },

  listInstallInvites(): AgentInstallInvite[] {
    const rows = db.prepare('SELECT * FROM agent_install_invites ORDER BY created_at DESC').all() as Record<string, unknown>[];
    return rows.map(toInvite);
  },

  getInstallInvite(id: string): AgentInstallInvite | undefined {
    const row = db.prepare('SELECT * FROM agent_install_invites WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    return row ? toInvite(row) : undefined;
  },

  consumeInstallInvite(token: string, usedByAgentId: string): { ok: boolean; reason?: string; invite?: AgentInstallInvite } {
    const tokenHash = hashToken(token);
    const row = db.prepare('SELECT * FROM agent_install_invites WHERE token_hash = ?').get(tokenHash) as Record<string, unknown> | undefined;
    if (!row) return { ok: false, reason: 'invalid_token' };

    const invite = toInvite(row);
    if (invite.status === 'used') return { ok: false, reason: 'already_used', invite };
    if (invite.status === 'expired') return { ok: false, reason: 'expired', invite };

    const result = db.prepare('UPDATE agent_install_invites SET used_at = ?, used_by_agent_id = ? WHERE id = ? AND used_at IS NULL')
      .run(nowIso(), usedByAgentId, invite.id);

    if (result.changes === 0) {
      return { ok: false, reason: 'already_used', invite: store.getInstallInvite(invite.id) };
    }

    return { ok: true, invite: store.getInstallInvite(invite.id) };
  },

  stats() {
    const totalMatches = (db.prepare('SELECT COUNT(*) as count FROM matches').get() as { count: number }).count;
    const totalAgents = (db.prepare('SELECT COUNT(*) as count FROM agents').get() as { count: number }).count;
    const enabledAgents = (db.prepare('SELECT COUNT(*) as count FROM agents WHERE enabled = 1').get() as { count: number }).count;
    const totalChallenges = (db.prepare('SELECT COUNT(*) as count FROM challenges').get() as { count: number }).count;
    const totalAttestations = (db.prepare('SELECT COUNT(*) as count FROM match_attestations').get() as { count: number }).count;
    const totalMarkets = (db.prepare('SELECT COUNT(*) as count FROM betting_markets').get() as { count: number }).count;
    const totalAutomationRuns = (db.prepare('SELECT COUNT(*) as count FROM automation_runs').get() as { count: number }).count;
    const activeInvites = (db.prepare("SELECT COUNT(*) as count FROM agent_install_invites WHERE used_at IS NULL AND (expires_at IS NULL OR expires_at > ?)").get(nowIso()) as { count: number }).count;
    return {
      totalMatches,
      totalAgents,
      enabledAgents,
      totalChallenges,
      totalAttestations,
      totalMarkets,
      totalAutomationRuns,
      activeInvites,
      dbFile
    };
  }
};
