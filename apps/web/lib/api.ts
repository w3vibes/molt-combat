export type ChallengeStatus = 'open' | 'accepted' | 'running' | 'awaiting_judgement' | 'completed' | 'cancelled';

export type Challenge = {
  id: string;
  topic: string;
  status: ChallengeStatus;
  challengerAgentId: string;
  opponentAgentId?: string;
  matchId?: string;
  winnerAgentId?: string;
  createdAt: string;
  updatedAt: string;
};

export type ChallengesResponse = {
  ok: boolean;
  challenges: Challenge[];
};

export type MatchSummary = {
  id: string;
  status: string;
  winner?: string;
  startedAt: string;
  turnsPlayed: number;
};

export type AgentSummary = {
  id: string;
  name: string;
  enabled: boolean;
  lastHealthStatus: 'unknown' | 'healthy' | 'unhealthy';
};

export type VerificationResponse = {
  ok: boolean;
  environment: string;
  appIds: string[];
  checks: {
    strictMode?: {
      requireEndpointMode: boolean;
      requireSandboxParity: boolean;
      requireEigenCompute: boolean;
      allowSimpleMode: boolean;
    };
  };
};

export type TrustedLeaderboardRow = {
  agentId: string;
  wins: number;
  losses: number;
  matches: number;
  winRate: number;
};

export type TrustedLeaderboardResponse = {
  ok: boolean;
  strictOnly: boolean;
  trustedMatchCount: number;
  leaderboard: TrustedLeaderboardRow[];
};

export type HealthResponse = {
  ok: boolean;
  service?: string;
  version?: string;
  uptimeSec?: number;
  now?: string;
  [key: string]: unknown;
};

export type JsonObject = Record<string, unknown>;

const paths = {
  // common read routes used by UI
  challenges: '/api/challenges',
  matches: '/api/matches',
  agents: '/api/agents',
  health: '/api/health',
  verification: '/api/verification/eigencompute',
  trustedLeaderboard: '/api/leaderboard/trusted',
  skill: '/skill.md'
} as const;

function absoluteUrl(path: string): string {
  if (typeof window === 'undefined') return path;
  return `${window.location.origin}${path}`;
}

function toFrontendPathFromBackendPath(backendPath: string): string {
  const normalized = backendPath.startsWith('/') ? backendPath : `/${backendPath}`;

  if (normalized === '/skill.md') return '/skill.md';

  // Backend legacy route: /api/agents/register should be exposed as /api/agents/register.
  if (normalized === '/api/agents/register') return '/api/agents/register';

  if (normalized.startsWith('/api/')) {
    return `/api/${normalized.slice('/api/'.length)}`;
  }

  return `/api${normalized}`;
}

function withQuery(path: string, query?: Record<string, string | number | boolean | undefined>): string {
  if (!query) return path;

  const params = new URLSearchParams();

  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null) continue;
    params.set(key, String(value));
  }

  const qs = params.toString();
  return qs ? `${path}?${qs}` : path;
}

async function requestText(path: string, init: RequestInit = {}): Promise<string> {
  const response = await fetch(path, {
    cache: 'no-store',
    ...init
  });

  const text = await response.text();

  if (!response.ok) {
    let errorMessage = `HTTP ${response.status}`;

    try {
      const json = text ? JSON.parse(text) : {};
      errorMessage = json?.error || json?.message || errorMessage;
    } catch {
      // keep fallback error message
    }

    throw new Error(errorMessage);
  }

  return text;
}

async function requestJson<T>(path: string, init: RequestInit = {}): Promise<T> {
  const text = await requestText(path, init);
  const json = text ? JSON.parse(text) : {};
  return json as T;
}

function jsonRequestInit(method: string, body?: JsonObject): RequestInit {
  return {
    method,
    headers: {
      'content-type': 'application/json'
    },
    body: body ? JSON.stringify(body) : undefined
  };
}

function requestBackendText(backendPath: string, init: RequestInit = {}) {
  return requestText(toFrontendPathFromBackendPath(backendPath), init);
}

function requestBackendJson<T>(backendPath: string, init: RequestInit = {}) {
  return requestJson<T>(toFrontendPathFromBackendPath(backendPath), init);
}

export const frontendApi = {
  baseUrl: '',
  paths,

  getSkillUrl() {
    return absoluteUrl(paths.skill);
  },

  // Generic wrappers (all backend endpoints can be reached via these)
  requestText,
  requestJson,

  requestBackendText(backendPath: string, init: RequestInit = {}) {
    return requestText(toFrontendPathFromBackendPath(backendPath), init);
  },

  requestBackendJson<T>(backendPath: string, init: RequestInit = {}) {
    return requestJson<T>(toFrontendPathFromBackendPath(backendPath), init);
  },

  // ---- System ----
  getHealth() {
    return requestJson<HealthResponse>(paths.health);
  },

  getMetrics() {
    return requestBackendJson<JsonObject>('/metrics');
  },

  getAuthStatus() {
    return requestBackendJson<JsonObject>('/auth/status');
  },

  getVerification() {
    return requestJson<VerificationResponse>(paths.verification);
  },

  getSkillMarkdown() {
    return requestText(paths.skill);
  },

  // ---- Install / Register ----
  listInstallInvites() {
    return requestBackendJson<JsonObject>('/install/invites');
  },

  createInstallInvite(payload: JsonObject) {
    return requestBackendJson<JsonObject>('/install/invites', jsonRequestInit('POST', payload));
  },

  installRegister(payload: JsonObject) {
    return requestBackendJson<JsonObject>('/install/register', jsonRequestInit('POST', payload));
  },

  registerAgent(payload: JsonObject) {
    return requestBackendJson<JsonObject>('/api/agents/register', jsonRequestInit('POST', payload));
  },

  // ---- Agents ----
  getAgents(includeDisabled?: boolean) {
    return requestJson<AgentSummary[]>(withQuery(paths.agents, { includeDisabled }));
  },

  getAgent(id: string) {
    return requestBackendJson<JsonObject>(`/agents/${encodeURIComponent(id)}`);
  },

  createAgent(payload: JsonObject) {
    return requestBackendJson<JsonObject>('/agents', jsonRequestInit('POST', payload));
  },

  updateAgent(id: string, payload: JsonObject) {
    return requestBackendJson<JsonObject>(`/agents/${encodeURIComponent(id)}`, jsonRequestInit('PATCH', payload));
  },

  deleteAgent(id: string) {
    return requestBackendJson<JsonObject>(`/agents/${encodeURIComponent(id)}`, { method: 'DELETE' });
  },

  probeAgentHealth(id: string) {
    return requestBackendJson<JsonObject>(`/agents/${encodeURIComponent(id)}/health`, jsonRequestInit('POST'));
  },

  // ---- Challenges ----
  getChallenges(status?: ChallengeStatus) {
    return requestJson<ChallengesResponse>(withQuery(paths.challenges, { status }));
  },

  getChallenge(id: string) {
    return requestBackendJson<JsonObject>(`/challenges/${encodeURIComponent(id)}`);
  },

  createChallenge(payload: JsonObject) {
    return requestBackendJson<JsonObject>('/challenges', jsonRequestInit('POST', payload));
  },

  acceptChallenge(id: string, payload: JsonObject) {
    return requestBackendJson<JsonObject>(`/challenges/${encodeURIComponent(id)}/accept`, jsonRequestInit('POST', payload));
  },

  prepareChallengeEscrow(id: string) {
    return requestBackendJson<JsonObject>(`/challenges/${encodeURIComponent(id)}/escrow/prepare`, jsonRequestInit('POST'));
  },

  startChallenge(id: string, payload?: JsonObject) {
    return requestBackendJson<JsonObject>(`/challenges/${encodeURIComponent(id)}/start`, jsonRequestInit('POST', payload));
  },

  adjudicateChallenge(id: string, payload: JsonObject) {
    return requestBackendJson<JsonObject>(`/challenges/${encodeURIComponent(id)}/adjudicate`, jsonRequestInit('POST', payload));
  },

  cancelChallenge(id: string) {
    return requestBackendJson<JsonObject>(`/challenges/${encodeURIComponent(id)}/cancel`, jsonRequestInit('POST'));
  },

  submitChallengeRound(id: string, turn: number, payload: JsonObject) {
    return requestBackendJson<JsonObject>(
      `/challenges/${encodeURIComponent(id)}/rounds/${encodeURIComponent(String(turn))}/submit`,
      jsonRequestInit('POST', payload)
    );
  },

  getChallengeState(id: string) {
    return requestBackendJson<JsonObject>(`/challenges/${encodeURIComponent(id)}/state`);
  },

  // ---- Matches ----
  getMatches() {
    return requestJson<MatchSummary[]>(paths.matches);
  },

  getMatch(id: string) {
    return requestBackendJson<JsonObject>(`/matches/${encodeURIComponent(id)}`);
  },

  getMatchAttestation(id: string) {
    return requestBackendJson<JsonObject>(`/matches/${encodeURIComponent(id)}/attestation`);
  },

  createMatch(payload: JsonObject) {
    return requestBackendJson<JsonObject>('/matches', jsonRequestInit('POST', payload));
  },

  fundMatch(id: string, payload: JsonObject) {
    return requestBackendJson<JsonObject>(`/matches/${encodeURIComponent(id)}/fund`, jsonRequestInit('POST', payload));
  },

  payoutMatch(id: string, payload: JsonObject) {
    return requestBackendJson<JsonObject>(`/matches/${encodeURIComponent(id)}/payout`, jsonRequestInit('POST', payload));
  },

  createMatchEscrow(id: string, payload: JsonObject) {
    return requestBackendJson<JsonObject>(`/matches/${encodeURIComponent(id)}/escrow/create`, jsonRequestInit('POST', payload));
  },

  settleMatchEscrow(id: string, payload: JsonObject) {
    return requestBackendJson<JsonObject>(`/matches/${encodeURIComponent(id)}/escrow/settle`, jsonRequestInit('POST', payload));
  },

  getMatchEscrowStatus(id: string, contractAddress: string) {
    return requestBackendJson<JsonObject>(
      withQuery(`/matches/${encodeURIComponent(id)}/escrow/status`, { contractAddress })
    );
  },

  // ---- Markets ----
  listMarkets(query?: { status?: string; subjectType?: string; subjectId?: string }) {
    return requestBackendJson<JsonObject>(withQuery('/markets', query));
  },

  getMarket(id: string) {
    return requestBackendJson<JsonObject>(`/markets/${encodeURIComponent(id)}`);
  },

  createMarket(payload: JsonObject) {
    return requestBackendJson<JsonObject>('/markets', jsonRequestInit('POST', payload));
  },

  placeMarketBet(id: string, payload: JsonObject) {
    return requestBackendJson<JsonObject>(`/markets/${encodeURIComponent(id)}/bets`, jsonRequestInit('POST', payload));
  },

  lockMarket(id: string) {
    return requestBackendJson<JsonObject>(`/markets/${encodeURIComponent(id)}/lock`, jsonRequestInit('POST'));
  },

  resolveMarket(id: string, payload: JsonObject) {
    return requestBackendJson<JsonObject>(`/markets/${encodeURIComponent(id)}/resolve`, jsonRequestInit('POST', payload));
  },

  cancelMarket(id: string) {
    return requestBackendJson<JsonObject>(`/markets/${encodeURIComponent(id)}/cancel`, jsonRequestInit('POST'));
  },

  // ---- Leaderboard ----
  getTrustedLeaderboard(limit = 200) {
    return requestJson<TrustedLeaderboardResponse>(`${paths.trustedLeaderboard}?limit=${limit}`);
  },

  // ---- Automation ----
  getAutomationStatus() {
    return requestBackendJson<JsonObject>('/automation/status');
  },

  tickAutomation() {
    return requestBackendJson<JsonObject>('/automation/tick', jsonRequestInit('POST'));
  },

  startAutomation() {
    return requestBackendJson<JsonObject>('/automation/start', jsonRequestInit('POST'));
  },

  stopAutomation() {
    return requestBackendJson<JsonObject>('/automation/stop', jsonRequestInit('POST'));
  }
};
