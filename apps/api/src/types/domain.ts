export type Resource = 'energy' | 'metal' | 'data';

export type SandboxProfile = {
  runtime: string;
  version: string;
  cpu: number;
  memory: number;
};

export type EigenComputeProfile = {
  appId: string;
  environment?: string;
  imageDigest?: string;
  signerAddress?: string;
};

export type AgentProfile = {
  id: string;
  name: string;
  endpoint: string;
  apiKey?: string;
  payoutAddress?: string;
};

export type AgentAction =
  | { type: 'gather'; resource: Resource; amount: number }
  | { type: 'trade'; give: Resource; receive: Resource; amount: number }
  | { type: 'attack'; targetAgentId: string; amount: number }
  | { type: 'hold' };

export type AgentState = {
  agentId: string;
  hp: number;
  wallet: Record<Resource, number>;
  score: number;
};

export type MatchConfig = {
  maxTurns: number;
  seed: number;
  attackCost: number;
  attackDamage: number;
};

export type MatchExecutionMode = 'endpoint' | 'simple';

export type MatchMeteringPolicy = {
  maxRequestBytes: number;
  maxResponseBytes: number;
  maxLatencyMs: number;
};

export type MatchTurnEnforcement = {
  timeout: boolean;
  schemaValidation: boolean;
  sandboxParity: boolean;
  meteringPolicy: boolean;
  eigenProof: boolean;
};

export type MatchTurnMetering = {
  agentId: string;
  latencyMs: number;
  requestBytes: number;
  responseBytes: number;
  timeoutMs: number;
  httpStatus?: number;
  timedOut: boolean;
  fallbackHold: boolean;
  invalidAction: boolean;
  enforcement: MatchTurnEnforcement;
  policyViolation?: string;
  error?: string;
  eigenProofVerified?: boolean;
  eigenProofReason?: string;
};

export type MatchReplayTurn = {
  turn: number;
  actions: Record<string, AgentAction>;
  states: AgentState[];
  metering?: Record<string, MatchTurnMetering>;
};

export type MatchCollusionMetrics = {
  headToHeadMatches24h: number;
  decisiveMatches24h: number;
  dominantAgentId?: string;
  dominantWinRate?: number;
};

export type MatchFairnessAudit = {
  sandboxParityRequired: boolean;
  sandboxParityEnforced: boolean;
  sandboxParityPassed: boolean;
  sandboxProfiles?: Record<string, SandboxProfile>;
  executionMode?: MatchExecutionMode;
  endpointExecutionRequired?: boolean;
  endpointExecutionPassed?: boolean;
  eigenComputeRequired?: boolean;
  eigenComputeEnforced?: boolean;
  eigenComputePassed?: boolean;
  eigenComputeProfiles?: Record<string, EigenComputeProfile>;
  eigenComputeEnvironmentRequired?: boolean;
  eigenComputeImageDigestRequired?: boolean;
  eigenSignerRequired?: boolean;
  eigenTurnProofRequired?: boolean;
  eigenTurnProofPassed?: boolean;
  independentAgentsRequired?: boolean;
  independentAgentsPassed?: boolean;
  independentAgentsReasons?: string[];
  collusionCheckRequired?: boolean;
  collusionCheckPassed?: boolean;
  collusionRiskReasons?: string[];
  collusionMetrics?: MatchCollusionMetrics;
  strictVerified?: boolean;
  rejectionReason?: string;
};

export type MatchMeteringTotals = {
  requestBytes: number;
  responseBytes: number;
  timeouts: number;
  fallbackHolds: number;
  invalidActions: number;
  policyViolations: number;
  eigenProofFailures: number;
};

export type MatchAuditRecord = {
  fairness: MatchFairnessAudit;
  meteringPolicy?: MatchMeteringPolicy;
  meteringTotals: MatchMeteringTotals;
};

export type MatchRecord = {
  id: string;
  status: 'pending' | 'running' | 'finished' | 'failed';
  startedAt: string;
  turnsPlayed: number;
  winner?: string;
  scorecardHash?: string;
  agents: AgentProfile[];
  replay: MatchReplayTurn[];
  config: MatchConfig;
  audit?: MatchAuditRecord;
};

export type MatchAttestationPayload = {
  matchId: string;
  startedAt: string;
  turnsPlayed: number;
  winner: string;
  scorecardHash: string;
  replayHash: string;
  auditHash: string;
  agentIds: string[];
  executionMode: MatchExecutionMode | 'unknown';
  strictVerified: boolean;
};

export type MatchAttestationRecord = {
  matchId: string;
  signerAddress: string;
  signature: string;
  signatureType: 'eip191';
  payloadHash: string;
  payload: MatchAttestationPayload;
  createdAt: string;
};

export type ChallengeStatus = 'open' | 'accepted' | 'running' | 'awaiting_judgement' | 'completed' | 'cancelled';

export type ChallengeStake = {
  mode: 'none' | 'usdc' | 'eth';
  contractAddress?: string;
  amountPerPlayer?: string;
  playerA?: string;
  playerB?: string;
  amountEth?: string;
  autoFund?: boolean;
};

export type ChallengeRecord = {
  id: string;
  topic: string;
  status: ChallengeStatus;
  challengerAgentId: string;
  opponentAgentId?: string;
  config: MatchConfig;
  stake: ChallengeStake;
  matchId?: string;
  winnerAgentId?: string;
  notes?: string;
  createdAt: string;
  updatedAt: string;
};

export type AgentInstallInvite = {
  id: string;
  note?: string;
  createdAt: string;
  expiresAt?: string;
  usedAt?: string;
  usedByAgentId?: string;
  status: 'active' | 'used' | 'expired';
  tokenPreview: string;
};

export type MarketStatus = 'open' | 'locked' | 'resolved' | 'cancelled';
export type MarketSubjectType = 'match' | 'challenge';

export type MarketPayout = {
  bettor: string;
  amount: string;
};

export type BettingMarketRecord = {
  id: string;
  subjectType: MarketSubjectType;
  subjectId: string;
  status: MarketStatus;
  outcomes: string[];
  feeBps: number;
  totalPool: string;
  payoutPool: string;
  feeAmount: string;
  resultOutcome?: string;
  payouts?: MarketPayout[];
  metadata?: Record<string, unknown>;
  createdAt: string;
  lockedAt?: string;
  resolvedAt?: string;
  updatedAt: string;
};

export type MarketPositionRecord = {
  id: string;
  marketId: string;
  bettor: string;
  outcome: string;
  amount: string;
  createdAt: string;
};

export type AutomationRunRecord = {
  id: string;
  automationType: 'escrow_settlement' | 'payout_settlement';
  status: 'ok' | 'error';
  startedAt: string;
  finishedAt: string;
  summary: Record<string, unknown>;
};

export type SeasonStatus = 'draft' | 'active' | 'completed' | 'archived';

export type SeasonRecord = {
  id: string;
  name: string;
  description?: string;
  status: SeasonStatus;
  startsAt?: string;
  endsAt?: string;
  metadata?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
};

export type TournamentFormat = 'single_elimination';
export type TournamentStatus = 'draft' | 'active' | 'completed' | 'cancelled';

export type TournamentChallengeTemplate = {
  config: MatchConfig;
  stake: ChallengeStake;
  notesPrefix?: string;
};

export type TournamentRecord = {
  id: string;
  seasonId?: string;
  name: string;
  format: TournamentFormat;
  status: TournamentStatus;
  participantAgentIds: string[];
  challengeTemplate: TournamentChallengeTemplate;
  championAgentId?: string;
  metadata?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
};

export type TournamentRoundStatus = 'pending' | 'active' | 'completed';

export type TournamentRoundRecord = {
  id: string;
  tournamentId: string;
  roundNumber: number;
  status: TournamentRoundStatus;
  createdAt: string;
  updatedAt: string;
};

export type TournamentFixtureStatus = 'pending' | 'ready' | 'running' | 'completed' | 'cancelled';

export type TournamentFixtureRecord = {
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
  createdAt: string;
  updatedAt: string;
};
