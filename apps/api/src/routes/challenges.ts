import { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { runMatch } from '../engine/combatEngine.js';
import { requireRole, resolveActorAgentId } from '../services/access.js';

function parseOrReply<T extends z.ZodTypeAny>(schema: T, input: unknown, reply: FastifyReply): z.infer<T> | null {
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    reply.code(400).send({ error: 'invalid_request', issues: parsed.error.issues });
    return null;
  }
  return parsed.data;
}
import { checkAgentHealth } from '../services/agentClient.js';
import { createEscrowMatch, getEscrowMatchStatus, settleEscrowMatch } from '../services/escrow.js';
import { autoResolveMarketsForMatch } from '../services/markets.js';
import {
  endpointExecutionRequiredByDefault,
  evaluateStrictSandboxPolicy,
  resolveAgentExecutionMode,
  simpleModeEnabledByDefault,
  toMatchFairnessAudit
} from '../services/fairness.js';
import { runEscrowSettlementTick } from '../services/automation.js';
import { signMatchAttestation } from '../services/attestation.js';
import { RegisteredAgent, store } from '../services/store.js';
import { AgentAction, AgentState, MatchConfig, MatchRecord } from '../types/domain.js';
import { stableHash } from '../utils/hash.js';
import { toMatchIdHex } from '../utils/ids.js';

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

const configPatchSchema = configSchema.partial();

const stakeSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('none') }),
  z.object({
    mode: z.literal('usdc'),
    contractAddress: z.string(),
    amountPerPlayer: z.string(),
    playerA: z.string(),
    playerB: z.string()
  })
]).default({ mode: 'none' as const });

const actionSchema = z.union([
  z.object({ type: z.literal('gather'), resource: z.enum(['energy', 'metal', 'data']), amount: z.number().int().min(1).max(10) }),
  z.object({ type: z.literal('trade'), give: z.enum(['energy', 'metal', 'data']), receive: z.enum(['energy', 'metal', 'data']), amount: z.number().int().min(1).max(10) }),
  z.object({ type: z.literal('attack'), targetAgentId: z.string().min(1), amount: z.number().int().min(1).max(10) }),
  z.object({ type: z.literal('hold') })
]);

function shouldUseSimpleMode(challenger: RegisteredAgent, opponent: RegisteredAgent): boolean {
  return resolveAgentExecutionMode(challenger) === 'simple' || resolveAgentExecutionMode(opponent) === 'simple';
}

function initialState(agentId: string): AgentState {
  return { agentId, hp: 100, score: 0, wallet: { energy: 5, metal: 5, data: 5 } };
}

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

function applyGather(state: AgentState, resource: 'energy' | 'metal' | 'data', amount: number) {
  state.wallet[resource] += clamp(amount, 1, 10);
  state.score += 1;
}

function applyTrade(state: AgentState, give: 'energy' | 'metal' | 'data', receive: 'energy' | 'metal' | 'data', amount: number) {
  const a = clamp(amount, 1, 10);
  if (state.wallet[give] >= a) {
    state.wallet[give] -= a;
    state.wallet[receive] += a;
    state.score += 2;
  }
}

function applyAttack(attacker: AgentState, defender: AgentState, amount: number, cfg: MatchConfig) {
  const a = clamp(amount, 1, 10);
  const cost = a * cfg.attackCost;
  if (attacker.wallet.energy >= cost) {
    attacker.wallet.energy -= cost;
    defender.hp = Math.max(0, defender.hp - a * cfg.attackDamage);
    attacker.score += 3;
  }
}

function applyAction(actorId: string, action: AgentAction, a: AgentState, b: AgentState, cfg: MatchConfig) {
  const self = actorId === a.agentId ? a : b;
  const other = actorId === a.agentId ? b : a;

  if (action.type === 'gather') applyGather(self, action.resource, action.amount);
  if (action.type === 'trade') applyTrade(self, action.give, action.receive, action.amount);
  if (action.type === 'attack') applyAttack(self, other, action.amount, cfg);
}

function resolveWinner(a: AgentState, b: AgentState): string | undefined {
  if (a.hp === b.hp) {
    if (a.score === b.score) return undefined;
    return a.score > b.score ? a.agentId : b.agentId;
  }
  return a.hp > b.hp ? a.agentId : b.agentId;
}

function currentStatesFromMatch(match: MatchRecord): [AgentState, AgentState] {
  if (match.replay.length > 0) {
    const latest = match.replay[match.replay.length - 1];
    const [aState, bState] = latest.states;
    return [structuredClone(aState), structuredClone(bState)];
  }

  return [initialState(match.agents[0].id), initialState(match.agents[1].id)];
}

function currentTurnForMatch(match: MatchRecord): number {
  return match.turnsPlayed + 1;
}

function defaultManualAudit(fairnessOverride?: NonNullable<MatchRecord['audit']>['fairness']) {
  return {
    fairness: fairnessOverride ?? {
      sandboxParityRequired: false,
      sandboxParityEnforced: false,
      sandboxParityPassed: true,
      executionMode: 'simple',
      endpointExecutionRequired: endpointExecutionRequiredByDefault(),
      endpointExecutionPassed: !endpointExecutionRequiredByDefault(),
      eigenComputeRequired: false,
      eigenComputeEnforced: false,
      eigenComputePassed: true,
      strictVerified: false,
      rejectionReason: endpointExecutionRequiredByDefault() ? 'endpoint_execution_required' : undefined
    },
    meteringTotals: {
      requestBytes: 0,
      responseBytes: 0,
      timeouts: 0,
      fallbackHolds: 0,
      invalidActions: 0
    }
  };
}

function getAgentOrError(agentId: string): RegisteredAgent | null {
  const agent = store.getAgent(agentId);
  if (!agent || !agent.enabled) return null;
  return agent;
}

function appendNotes(...items: Array<string | undefined>) {
  return items.filter(Boolean).join('\n') || undefined;
}

function winnerWalletForChallenge(challenge: {
  challengerAgentId: string;
  opponentAgentId?: string;
  stake: { mode: 'none' | 'usdc'; playerA?: string; playerB?: string };
}, winnerAgentId: string): string | null {
  if (challenge.stake.mode !== 'usdc') return null;

  if (winnerAgentId === challenge.challengerAgentId) {
    return challenge.stake.playerA || null;
  }

  if (winnerAgentId === challenge.opponentAgentId) {
    return challenge.stake.playerB || null;
  }

  const winnerAgent = store.getAgent(winnerAgentId);
  return winnerAgent?.payoutAddress || null;
}

async function runChallengeMatch(params: {
  challenger: RegisteredAgent;
  opponent: RegisteredAgent;
  config: MatchConfig;
  fairnessAudit: NonNullable<MatchRecord['audit']>['fairness'];
  matchId: string;
}) {
  if (params.fairnessAudit.sandboxParityEnforced && !params.fairnessAudit.sandboxParityPassed) {
    throw new Error(`sandbox_parity_mismatch:${params.fairnessAudit.rejectionReason || 'unknown'}`);
  }

  if (params.fairnessAudit.endpointExecutionRequired && !params.fairnessAudit.endpointExecutionPassed) {
    throw new Error(`endpoint_execution_required:${params.fairnessAudit.rejectionReason || 'unknown'}`);
  }

  if (params.fairnessAudit.eigenComputeEnforced && !params.fairnessAudit.eigenComputePassed) {
    throw new Error(`eigencompute_policy_failed:${params.fairnessAudit.rejectionReason || 'unknown'}`);
  }

  const match = await runMatch({
    id: params.matchId,
    agents: [
      {
        id: params.challenger.id,
        name: params.challenger.name,
        endpoint: params.challenger.endpoint,
        apiKey: params.challenger.apiKey,
        payoutAddress: params.challenger.payoutAddress
      },
      {
        id: params.opponent.id,
        name: params.opponent.name,
        endpoint: params.opponent.endpoint,
        apiKey: params.opponent.apiKey,
        payoutAddress: params.opponent.payoutAddress
      }
    ],
    config: params.config,
    fairness: params.fairnessAudit
  });

  store.saveMatch(match);
  return { match };
}

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

type EscrowOnchainStatus = Awaited<ReturnType<typeof getEscrowMatchStatus>>;

type EscrowPrepareResult = {
  ok: boolean;
  challenge: NonNullable<ReturnType<typeof store.getChallenge>>;
  matchId: string;
  matchIdHex: string;
  txHash: string | null;
  created: boolean;
  depositsReady: boolean;
  status: EscrowOnchainStatus | null;
  error: string | null;
};

function normalizeAddress(value: string | undefined | null): string {
  return (value || '').trim().toLowerCase();
}

function isZeroAddress(value: string | undefined | null): boolean {
  return normalizeAddress(value) === ZERO_ADDRESS;
}

function nextMatchIdForChallenge(challengeId: string): string {
  const now = Date.now();
  const suffix = stableHash(`${challengeId}:${now}`).slice(0, 6);
  return `match_${now}_${suffix}`;
}

function ensureChallengeMatchId(challengeId: string, challenge: NonNullable<ReturnType<typeof store.getChallenge>>) {
  if (challenge.matchId) {
    return {
      challenge,
      matchId: challenge.matchId
    };
  }

  const matchId = nextMatchIdForChallenge(challengeId);
  const updated = store.patchChallenge(challengeId, { matchId });

  return {
    challenge: updated ?? {
      ...challenge,
      matchId
    },
    matchId
  };
}

async function prepareChallengeEscrow(challengeId: string, challenge: NonNullable<ReturnType<typeof store.getChallenge>>): Promise<EscrowPrepareResult> {
  const { challenge: withMatchId, matchId } = ensureChallengeMatchId(challengeId, challenge);
  const matchIdHex = toMatchIdHex(matchId);

  if (withMatchId.stake.mode !== 'usdc') {
    return {
      ok: false,
      challenge: withMatchId,
      matchId,
      matchIdHex,
      txHash: null,
      created: false,
      depositsReady: false,
      status: null,
      error: 'stake_mode_not_usdc'
    };
  }

  const signerKey = process.env.PAYOUT_SIGNER_PRIVATE_KEY || process.env.OPERATOR_PRIVATE_KEY;
  const { contractAddress, playerA, playerB, amountPerPlayer } = withMatchId.stake;

  if (!contractAddress || !playerA || !playerB || !amountPerPlayer) {
    return {
      ok: false,
      challenge: withMatchId,
      matchId,
      matchIdHex,
      txHash: null,
      created: false,
      depositsReady: false,
      status: null,
      error: 'missing_usdc_stake_fields'
    };
  }

  if (!process.env.SEPOLIA_RPC_URL || !signerKey) {
    return {
      ok: false,
      challenge: withMatchId,
      matchId,
      matchIdHex,
      txHash: null,
      created: false,
      depositsReady: false,
      status: null,
      error: 'missing_chain_config'
    };
  }

  let status: EscrowOnchainStatus | null = null;
  try {
    status = await getEscrowMatchStatus({
      rpcUrl: process.env.SEPOLIA_RPC_URL,
      contractAddress,
      matchIdHex
    });
  } catch {
    status = null;
  }

  let txHash: string | null = null;
  const hasEscrow = status && !isZeroAddress(status.playerA) && !isZeroAddress(status.playerB) && status.amountPerPlayer !== '0';

  if (!hasEscrow) {
    try {
      const receipt = await createEscrowMatch({
        rpcUrl: process.env.SEPOLIA_RPC_URL,
        privateKey: signerKey,
        contractAddress,
        matchIdHex,
        playerA,
        playerB,
        amountPerPlayer
      });
      txHash = receipt?.hash ?? null;
    } catch (error) {
      return {
        ok: false,
        challenge: withMatchId,
        matchId,
        matchIdHex,
        txHash: null,
        created: false,
        depositsReady: false,
        status,
        error: error instanceof Error ? error.message : 'escrow_create_failed'
      };
    }

    try {
      status = await getEscrowMatchStatus({
        rpcUrl: process.env.SEPOLIA_RPC_URL,
        contractAddress,
        matchIdHex
      });
    } catch (error) {
      return {
        ok: false,
        challenge: withMatchId,
        matchId,
        matchIdHex,
        txHash,
        created: true,
        depositsReady: false,
        status: null,
        error: error instanceof Error ? error.message : 'escrow_status_unavailable'
      };
    }
  }

  if (!status || isZeroAddress(status.playerA) || isZeroAddress(status.playerB) || status.amountPerPlayer === '0') {
    return {
      ok: false,
      challenge: withMatchId,
      matchId,
      matchIdHex,
      txHash,
      created: Boolean(txHash),
      depositsReady: false,
      status,
      error: 'escrow_uninitialized'
    };
  }

  const mismatches: string[] = [];
  if (normalizeAddress(status.playerA) !== normalizeAddress(playerA)) mismatches.push('playerA');
  if (normalizeAddress(status.playerB) !== normalizeAddress(playerB)) mismatches.push('playerB');
  if (String(status.amountPerPlayer) !== String(amountPerPlayer)) mismatches.push('amountPerPlayer');

  if (mismatches.length > 0) {
    return {
      ok: false,
      challenge: withMatchId,
      matchId,
      matchIdHex,
      txHash,
      created: Boolean(txHash),
      depositsReady: false,
      status,
      error: `escrow_profile_mismatch:${mismatches.join(',')}`
    };
  }

  const depositsReady = status.playerADeposited && status.playerBDeposited;

  return {
    ok: true,
    challenge: withMatchId,
    matchId,
    matchIdHex,
    txHash,
    created: Boolean(txHash),
    depositsReady,
    status,
    error: null
  };
}

async function finalizeChallengeFromMatch(params: {
  challengeId: string;
  challenge: NonNullable<ReturnType<typeof store.getChallenge>>;
  opponentAgentId: string;
  match: MatchRecord;
  escrowTxHash?: string | null;
  escrowError?: string | null;
}) {
  const attestation = await signMatchAttestation(params.match);
  if (attestation) {
    store.saveMatchAttestation(attestation);
  }

  const baseNotes = appendNotes(
    params.challenge.notes,
    params.escrowError ? `escrow_error:${params.escrowError}` : undefined
  );

  if (!params.match.winner) {
    const updated = store.patchChallenge(params.challengeId, {
      status: 'awaiting_judgement',
      opponentAgentId: params.opponentAgentId,
      matchId: params.match.id,
      winnerAgentId: undefined,
      notes: appendNotes(baseNotes, 'winner_undetermined')
    });

    return {
      ok: true,
      challenge: updated,
      match: {
        ...params.match,
        matchIdHex: toMatchIdHex(params.match.id)
      },
      attestation: attestation ?? null,
      markets: {
        checked: 0,
        resolved: 0,
        skipped: []
      },
      escrow: {
        mode: params.challenge.stake.mode,
        txHash: params.escrowTxHash ?? null,
        error: params.escrowError ?? null,
        automation: null
      },
      message: 'Match ended without a decisive winner. Use /challenges/:id/adjudicate to set winner and settle.'
    };
  }

  const marketResolution = autoResolveMarketsForMatch({
    matchId: params.match.id,
    challengeId: params.challenge.id,
    winnerAgentId: params.match.winner
  });

  const updated = store.patchChallenge(params.challengeId, {
    status: 'completed',
    opponentAgentId: params.opponentAgentId,
    matchId: params.match.id,
    winnerAgentId: params.match.winner,
    notes: baseNotes
  });

  const automation = params.challenge.stake.mode === 'usdc'
    ? await runEscrowSettlementTick('challenge_completion')
    : null;

  return {
    ok: true,
    challenge: updated,
    match: {
      ...params.match,
      matchIdHex: toMatchIdHex(params.match.id)
    },
    attestation: attestation ?? null,
    markets: marketResolution,
    escrow: {
      mode: params.challenge.stake.mode,
      txHash: params.escrowTxHash ?? null,
      error: params.escrowError ?? null,
      automation
    }
  };
}

export async function challengeRoutes(app: FastifyInstance) {
  app.get('/challenges', async (req, reply) => {
    if (!requireRole(req, reply, 'readonly')) return;

    const parsed = z.object({ status: z.enum(['open', 'accepted', 'running', 'awaiting_judgement', 'completed', 'cancelled']).optional() }).safeParse(req.query || {});
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_request', issues: parsed.error.issues });

    return {
      ok: true,
      challenges: store.listChallenges(parsed.data.status)
    };
  });

  app.get('/challenges/:id', async (req, reply) => {
    if (!requireRole(req, reply, 'readonly')) return;
    const id = (req.params as { id: string }).id;
    const challenge = store.getChallenge(id);
    if (!challenge) return reply.code(404).send({ error: 'not_found' });
    return { ok: true, challenge };
  });

  app.post('/challenges', async (req, reply) => {
    if (!requireRole(req, reply, 'agent')) return;

    const parsed = z.object({
      topic: z.string().min(3).max(240),
      challengerAgentId: z.string().min(1),
      opponentAgentId: z.string().min(1).optional(),
      config: configPatchSchema.optional(),
      stake: stakeSchema.optional(),
      notes: z.string().max(600).optional()
    }).safeParse(req.body);

    if (!parsed.success) return reply.code(400).send({ error: 'invalid_request', issues: parsed.error.issues });

    const body = parsed.data;
    const actorAgentId = resolveActorAgentId(req);

    if (actorAgentId && body.challengerAgentId !== actorAgentId) {
      return reply.code(403).send({
        error: 'forbidden_actor',
        actorAgentId,
        message: 'Agent API key can only create challenges where challengerAgentId equals the authenticated agent.'
      });
    }

    if (!getAgentOrError(body.challengerAgentId)) {
      return reply.code(400).send({ error: 'invalid_challenger_agent' });
    }

    if (body.opponentAgentId && !getAgentOrError(body.opponentAgentId)) {
      return reply.code(400).send({ error: 'invalid_opponent_agent' });
    }

    const config = configSchema.parse({
      ...DEFAULT_CONFIG,
      ...(body.config || {})
    });

    const challenge = store.createChallenge({
      topic: body.topic,
      challengerAgentId: body.challengerAgentId,
      opponentAgentId: body.opponentAgentId,
      config,
      stake: body.stake || { mode: 'none' },
      notes: body.notes,
      status: body.opponentAgentId ? 'accepted' : 'open'
    });

    return reply.code(201).send({ ok: true, challenge });
  });

  app.post('/challenges/:id/accept', async (req, reply) => {
    if (!requireRole(req, reply, 'agent')) return;

    const id = (req.params as { id: string }).id;
    const challenge = store.getChallenge(id);
    if (!challenge) return reply.code(404).send({ error: 'not_found' });
    if (challenge.status !== 'open' && challenge.status !== 'accepted') {
      return reply.code(400).send({ error: 'invalid_status', status: challenge.status });
    }

    const parsed = z.object({ opponentAgentId: z.string().min(1) }).safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_request', issues: parsed.error.issues });

    const actorAgentId = resolveActorAgentId(req);
    if (actorAgentId && parsed.data.opponentAgentId !== actorAgentId) {
      return reply.code(403).send({
        error: 'forbidden_actor',
        actorAgentId,
        message: 'Agent API key can only accept challenges as itself.'
      });
    }

    if (challenge.opponentAgentId && challenge.opponentAgentId !== parsed.data.opponentAgentId) {
      return reply.code(400).send({
        error: 'opponent_locked',
        message: 'Challenge opponent is already set and cannot be changed.'
      });
    }

    if (!getAgentOrError(parsed.data.opponentAgentId)) {
      return reply.code(400).send({ error: 'invalid_opponent_agent' });
    }

    const updated = store.patchChallenge(id, {
      opponentAgentId: parsed.data.opponentAgentId,
      status: 'accepted'
    });

    return { ok: true, challenge: updated };
  });

  app.post('/challenges/:id/escrow/prepare', async (req, reply) => {
    if (!requireRole(req, reply, 'agent')) return;

    const id = (req.params as { id: string }).id;
    const challenge = store.getChallenge(id);
    if (!challenge) return reply.code(404).send({ error: 'not_found' });

    if (challenge.status === 'completed' || challenge.status === 'cancelled') {
      return reply.code(400).send({
        error: 'invalid_status',
        status: challenge.status,
        message: 'Escrow preparation is only available before challenge completion/cancellation.'
      });
    }

    if (challenge.stake.mode !== 'usdc') {
      return reply.code(400).send({
        error: 'stake_mode_not_usdc',
        message: 'Escrow preparation is only valid for stake.mode="usdc" challenges.'
      });
    }

    const actorAgentId = resolveActorAgentId(req);
    const participants = [challenge.challengerAgentId, challenge.opponentAgentId].filter((value): value is string => Boolean(value));
    if (actorAgentId && !participants.includes(actorAgentId)) {
      return reply.code(403).send({
        error: 'forbidden_actor',
        actorAgentId,
        message: 'Agent API key can only prepare escrow for challenges where the authenticated agent is a participant.'
      });
    }

    const escrow = await prepareChallengeEscrow(id, challenge);
    if (!escrow.ok) {
      return reply.code(400).send({
        error: 'escrow_prepare_failed',
        reason: escrow.error,
        challenge: escrow.challenge,
        escrow: {
          mode: 'usdc',
          matchId: escrow.matchId,
          matchIdHex: escrow.matchIdHex,
          txHash: escrow.txHash,
          created: escrow.created,
          status: escrow.status,
          readyToStart: false
        }
      });
    }

    return {
      ok: true,
      challenge: escrow.challenge,
      escrow: {
        mode: 'usdc',
        matchId: escrow.matchId,
        matchIdHex: escrow.matchIdHex,
        txHash: escrow.txHash,
        created: escrow.created,
        status: escrow.status,
        readyToStart: escrow.depositsReady
      }
    };
  });

  app.post('/challenges/:id/start', async (req, reply) => {
    if (!requireRole(req, reply, 'agent')) return;

    const id = (req.params as { id: string }).id;
    const challenge = store.getChallenge(id);
    if (!challenge) return reply.code(404).send({ error: 'not_found' });

    if (challenge.status === 'completed') {
      return reply.code(400).send({ error: 'already_completed', challenge });
    }

    if (challenge.status === 'cancelled') {
      return reply.code(400).send({ error: 'cancelled', challenge });
    }

    if (challenge.status === 'awaiting_judgement') {
      return reply.code(400).send({
        error: 'awaiting_judgement',
        message: 'Challenge already ran without a decisive winner. Use /challenges/:id/adjudicate.',
        challenge
      });
    }

    const parsed = z.object({ opponentAgentId: z.string().min(1).optional() }).safeParse(req.body || {});
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_request', issues: parsed.error.issues });

    const requestedOpponentId = parsed.data.opponentAgentId;

    if (challenge.opponentAgentId && requestedOpponentId && requestedOpponentId !== challenge.opponentAgentId) {
      return reply.code(400).send({
        error: 'opponent_locked',
        message: 'Challenge opponent is already set and cannot be changed at start.'
      });
    }

    const opponentAgentId = challenge.opponentAgentId || requestedOpponentId;
    if (!opponentAgentId) {
      return reply.code(400).send({ error: 'missing_opponent_agent', message: 'Open challenge requires opponentAgentId to start.' });
    }

    const actorAgentId = resolveActorAgentId(req);
    if (actorAgentId && actorAgentId !== challenge.challengerAgentId && actorAgentId !== opponentAgentId) {
      return reply.code(403).send({
        error: 'forbidden_actor',
        actorAgentId,
        message: 'Agent API key can only start challenges where the authenticated agent is a participant.'
      });
    }

    const challenger = getAgentOrError(challenge.challengerAgentId);
    const opponent = getAgentOrError(opponentAgentId);
    if (!challenger || !opponent) {
      return reply.code(400).send({ error: 'invalid_or_disabled_agents' });
    }

    const simpleModeRequested = shouldUseSimpleMode(challenger, opponent);
    if (simpleModeRequested && !simpleModeEnabledByDefault()) {
      return reply.code(400).send({
        error: 'endpoint_execution_required',
        message: 'Simple mode is disabled. Run endpoint agents in strict sandbox mode.'
      });
    }

    const executionMode = simpleModeRequested ? 'simple' : 'endpoint';
    const strictPolicy = evaluateStrictSandboxPolicy({
      agents: [challenger, opponent],
      executionMode,
      endpointModeRequired: endpointExecutionRequiredByDefault()
    });
    const fairnessAudit = toMatchFairnessAudit(strictPolicy);

    if (!strictPolicy.passed) {
      return reply.code(400).send({
        error: 'strict_sandbox_policy_failed',
        reason: strictPolicy.reason,
        strictPolicy: {
          executionMode: strictPolicy.executionMode,
          endpointModeRequired: strictPolicy.endpointModeRequired,
          endpointModePassed: strictPolicy.endpointModePassed,
          parity: strictPolicy.parity,
          eigenCompute: strictPolicy.eigenCompute
        }
      });
    }

    let challengeForStart = challenge;
    let escrowPreflight: EscrowPrepareResult | null = null;

    if (challenge.stake.mode === 'usdc') {
      escrowPreflight = await prepareChallengeEscrow(id, challenge);
      challengeForStart = escrowPreflight.challenge;

      if (!escrowPreflight.ok) {
        return reply.code(400).send({
          error: 'escrow_prepare_failed',
          reason: escrowPreflight.error,
          message: 'Failed to prepare USDC escrow match before challenge start.',
          challenge: challengeForStart,
          escrow: {
            mode: 'usdc',
            matchId: escrowPreflight.matchId,
            matchIdHex: escrowPreflight.matchIdHex,
            txHash: escrowPreflight.txHash,
            created: escrowPreflight.created,
            status: escrowPreflight.status,
            readyToStart: false
          }
        });
      }

      if (!escrowPreflight.depositsReady) {
        const reverted = store.patchChallenge(id, {
          status: 'accepted',
          opponentAgentId,
          matchId: escrowPreflight.matchId
        });

        return reply.code(409).send({
          error: 'escrow_pending_deposits',
          message: 'USDC deposits must be completed before challenge start.',
          challenge: reverted ?? challengeForStart,
          escrow: {
            mode: 'usdc',
            matchId: escrowPreflight.matchId,
            matchIdHex: escrowPreflight.matchIdHex,
            txHash: escrowPreflight.txHash,
            created: escrowPreflight.created,
            status: escrowPreflight.status,
            readyToStart: false
          }
        });
      }
    }

    if (executionMode === 'simple') {
      const existingMatch = challengeForStart.matchId ? store.getMatch(challengeForStart.matchId) : undefined;

      if (existingMatch && existingMatch.status === 'running') {
        const [stateA, stateB] = currentStatesFromMatch(existingMatch);
        const pendingTurn = currentTurnForMatch(existingMatch);
        const pendingSubmissions = store.getChallengeRoundSubmissions(id, pendingTurn);

        return {
          ok: true,
          mode: 'simple',
          challenge: challengeForStart,
          match: {
            ...existingMatch,
            matchIdHex: toMatchIdHex(existingMatch.id)
          },
          round: {
            turn: pendingTurn,
            submittedBy: pendingSubmissions.map((item) => item.agentId),
            awaiting: [challengeForStart.challengerAgentId, opponentAgentId].filter((agentId) => !pendingSubmissions.some((item) => item.agentId === agentId))
          },
          states: [stateA, stateB],
          message: 'Simple mode running. Submit actions with /challenges/:id/rounds/:turn/submit.'
        };
      }

      const matchId = challengeForStart.matchId || nextMatchIdForChallenge(id);
      const manualMatch: MatchRecord = {
        id: matchId,
        status: 'running',
        startedAt: new Date().toISOString(),
        turnsPlayed: 0,
        agents: [
          {
            id: challenger.id,
            name: challenger.name,
            endpoint: challenger.endpoint,
            apiKey: challenger.apiKey,
            payoutAddress: challenger.payoutAddress
          },
          {
            id: opponent.id,
            name: opponent.name,
            endpoint: opponent.endpoint,
            apiKey: opponent.apiKey,
            payoutAddress: opponent.payoutAddress
          }
        ],
        replay: [],
        config: challengeForStart.config,
        audit: defaultManualAudit(fairnessAudit)
      };

      store.saveMatch(manualMatch);
      const updatedChallenge = store.patchChallenge(id, {
        status: 'running',
        opponentAgentId,
        matchId
      });

      return {
        ok: true,
        mode: 'simple',
        challenge: updatedChallenge,
        match: {
          ...manualMatch,
          matchIdHex: toMatchIdHex(matchId)
        },
        round: {
          turn: 1,
          submittedBy: [],
          awaiting: [challengeForStart.challengerAgentId, opponentAgentId]
        },
        states: [initialState(challengeForStart.challengerAgentId), initialState(opponentAgentId)],
        message: 'Simple mode started. Submit actions with /challenges/:id/rounds/:turn/submit.'
      };
    }

    const [challengerHealth, opponentHealth] = await Promise.all([
      checkAgentHealth(challenger),
      checkAgentHealth(opponent)
    ]);

    store.setAgentHealth({
      id: challenger.id,
      status: challengerHealth.ok ? 'healthy' : 'unhealthy',
      error: challengerHealth.error
    });

    store.setAgentHealth({
      id: opponent.id,
      status: opponentHealth.ok ? 'healthy' : 'unhealthy',
      error: opponentHealth.error
    });

    if (!challengerHealth.ok || !opponentHealth.ok) {
      return reply.code(400).send({
        error: 'agent_unhealthy',
        challenger: challengerHealth,
        opponent: opponentHealth
      });
    }

    const matchId = challengeForStart.matchId || nextMatchIdForChallenge(id);
    store.patchChallenge(id, { status: 'running', opponentAgentId, matchId });

    try {
      const { match } = await runChallengeMatch({
        challenger,
        opponent,
        config: challengeForStart.config,
        fairnessAudit,
        matchId
      });

      return finalizeChallengeFromMatch({
        challengeId: id,
        challenge: challengeForStart,
        opponentAgentId,
        match,
        escrowTxHash: escrowPreflight?.txHash ?? null,
        escrowError: escrowPreflight?.error ?? null
      });
    } catch (error) {
      store.patchChallenge(id, { status: 'accepted', opponentAgentId, matchId });
      return reply.code(500).send({
        error: 'challenge_start_failed',
        message: error instanceof Error ? error.message : 'unknown_error'
      });
    }
  });

  app.post('/challenges/:id/adjudicate', async (req, reply) => {
    if (!requireRole(req, reply, 'agent')) return;

    const id = (req.params as { id: string }).id;
    const challenge = store.getChallenge(id);
    if (!challenge) return reply.code(404).send({ error: 'not_found' });

    const actorAgentId = resolveActorAgentId(req);
    if (actorAgentId && actorAgentId !== challenge.challengerAgentId && actorAgentId !== challenge.opponentAgentId) {
      return reply.code(403).send({
        error: 'forbidden_actor',
        actorAgentId,
        message: 'Agent API key can only adjudicate a challenge when the authenticated agent is a participant.'
      });
    }

    const parsed = z.object({
      winnerAgentId: z.string().min(1),
      settleEscrow: z.boolean().optional(),
      note: z.string().max(600).optional()
    }).safeParse(req.body || {});

    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_request', issues: parsed.error.issues });
    }

    const body = parsed.data;

    if (![challenge.challengerAgentId, challenge.opponentAgentId].includes(body.winnerAgentId)) {
      return reply.code(400).send({
        error: 'invalid_winner_agent',
        message: 'winnerAgentId must be challenger or opponent of this challenge.'
      });
    }

    if (!challenge.matchId) {
      return reply.code(400).send({
        error: 'missing_match',
        message: 'Challenge has no linked match to adjudicate.'
      });
    }

    const match = store.getMatch(challenge.matchId);
    if (!match) {
      return reply.code(404).send({
        error: 'match_not_found',
        matchId: challenge.matchId
      });
    }

    const adjudicatedMatch = {
      ...match,
      winner: body.winnerAgentId,
      scorecardHash: stableHash({
        replay: match.replay,
        winner: body.winnerAgentId,
        turns: match.turnsPlayed,
        config: match.config,
        audit: match.audit
      })
    };

    store.saveMatch(adjudicatedMatch);

    const attestation = await signMatchAttestation(adjudicatedMatch);
    if (attestation) {
      store.saveMatchAttestation(attestation);
    }

    const updated = store.patchChallenge(id, {
      status: 'completed',
      winnerAgentId: body.winnerAgentId,
      notes: appendNotes(
        challenge.notes,
        body.note,
        `manual_adjudication:${new Date().toISOString()}:${body.winnerAgentId}`
      )
    });

    const marketResolution = autoResolveMarketsForMatch({
      matchId: adjudicatedMatch.id,
      challengeId: id,
      winnerAgentId: body.winnerAgentId
    });

    let escrowResult: {
      attempted: boolean;
      txHash?: string;
      error?: string;
      winnerWallet?: string;
    } = { attempted: false };

    if (body.settleEscrow && challenge.stake.mode === 'usdc') {
      const signerKey = process.env.PAYOUT_SIGNER_PRIVATE_KEY || process.env.OPERATOR_PRIVATE_KEY;
      const contractAddress = challenge.stake.contractAddress;
      const winnerWallet = winnerWalletForChallenge(challenge, body.winnerAgentId);

      if (!process.env.SEPOLIA_RPC_URL || !signerKey || !contractAddress || !winnerWallet) {
        escrowResult = {
          attempted: true,
          error: 'missing_chain_or_winner_wallet_config',
          winnerWallet: winnerWallet || undefined
        };
      } else {
        try {
          const receipt = await settleEscrowMatch({
            rpcUrl: process.env.SEPOLIA_RPC_URL,
            privateKey: signerKey,
            contractAddress,
            matchIdHex: toMatchIdHex(adjudicatedMatch.id),
            winner: winnerWallet
          });

          escrowResult = {
            attempted: true,
            txHash: receipt?.hash ?? undefined,
            winnerWallet
          };
        } catch (error) {
          escrowResult = {
            attempted: true,
            error: error instanceof Error ? error.message : 'escrow_settle_failed',
            winnerWallet
          };
        }
      }
    }

    const automation = challenge.stake.mode === 'usdc'
      ? await runEscrowSettlementTick('manual_adjudication')
      : null;

    return {
      ok: true,
      challenge: updated,
      match: {
        ...adjudicatedMatch,
        matchIdHex: toMatchIdHex(adjudicatedMatch.id)
      },
      attestation: attestation ?? null,
      markets: marketResolution,
      escrow: {
        ...escrowResult,
        automation
      }
    };
  });

  app.post('/challenges/:id/cancel', async (req, reply) => {
    if (!requireRole(req, reply, 'agent')) return;
    const id = (req.params as { id: string }).id;
    const challenge = store.getChallenge(id);
    if (!challenge) return reply.code(404).send({ error: 'not_found' });

    const actorAgentId = resolveActorAgentId(req);
    if (actorAgentId && actorAgentId !== challenge.challengerAgentId && actorAgentId !== challenge.opponentAgentId) {
      return reply.code(403).send({
        error: 'forbidden_actor',
        actorAgentId,
        message: 'Agent API key can only cancel challenges where the authenticated agent is a participant.'
      });
    }

    const updated = store.patchChallenge(id, { status: 'cancelled' });
    return { ok: true, challenge: updated };
  });

  app.post('/challenges/:id/rounds/:turn/submit', async (req, reply) => {
    if (!requireRole(req, reply, 'agent')) return;

    const challengeId = (req.params as { id: string }).id;
    const turn = Number((req.params as { turn: string }).turn);

    if (!Number.isInteger(turn) || turn < 1) {
      return reply.code(400).send({ error: 'invalid_turn', message: 'Turn must be an integer >= 1' });
    }

    const challenge = store.getChallenge(challengeId);
    if (!challenge) return reply.code(404).send({ error: 'not_found' });

    if (challenge.status !== 'running') {
      return reply.code(400).send({ error: 'invalid_status', status: challenge.status, message: 'Challenge is not running' });
    }

    if (!challenge.matchId) {
      return reply.code(400).send({ error: 'missing_match', message: 'Challenge has no match' });
    }

    if (!challenge.opponentAgentId) {
      return reply.code(400).send({ error: 'missing_opponent', message: 'Challenge has no opponent yet' });
    }

    const match = store.getMatch(challenge.matchId);
    if (!match) return reply.code(404).send({ error: 'match_not_found' });

    if (match.audit?.fairness?.executionMode !== 'simple') {
      return reply.code(400).send({
        error: 'endpoint_execution_match',
        message: 'Round submit is only available for simple-mode matches.'
      });
    }

    if (match.status !== 'running') {
      return reply.code(400).send({ error: 'invalid_match_status', status: match.status, message: 'Match is not running' });
    }

    const expectedTurn = currentTurnForMatch(match);
    if (turn !== expectedTurn) {
      return reply.code(409).send({
        error: 'unexpected_turn',
        expectedTurn,
        message: `Submit to turn ${expectedTurn}`
      });
    }

    const actorAgentId = resolveActorAgentId(req);
    if (!actorAgentId) {
      return reply.code(403).send({
        error: 'agent_api_key_required',
        message: 'Use an agent API key to submit actions in simple mode.'
      });
    }

    const authenticatedId = actorAgentId;

    if (![challenge.challengerAgentId, challenge.opponentAgentId].includes(authenticatedId)) {
      return reply.code(403).send({
        error: 'forbidden_actor',
        message: 'Only challenge participants can submit actions'
      });
    }

    const parsed = parseOrReply(z.object({
      action: actionSchema
    }), req.body, reply);
    if (!parsed) return;

    store.upsertChallengeRoundSubmission({
      challengeId,
      turn,
      agentId: authenticatedId,
      action: parsed.action
    });

    const allSubmissions = store.getChallengeRoundSubmissions(challengeId, turn);

    const challengerSubmit = allSubmissions.find((s) => s.agentId === challenge.challengerAgentId);
    const opponentSubmit = allSubmissions.find((s) => s.agentId === challenge.opponentAgentId);

    if (challengerSubmit && opponentSubmit) {
      const [stateA, stateB] = currentStatesFromMatch(match);

      applyAction(challengerSubmit.agentId, challengerSubmit.action, stateA, stateB, match.config);
      applyAction(opponentSubmit.agentId, opponentSubmit.action, stateB, stateA, match.config);

      const isLastTurn = turn >= match.config.maxTurns;
      const matchOver = isLastTurn || stateA.hp <= 0 || stateB.hp <= 0;
      const winner = matchOver ? resolveWinner(stateA, stateB) : undefined;

      const updatedMatch: MatchRecord = {
        ...match,
        status: matchOver ? 'finished' : 'running',
        turnsPlayed: turn,
        winner,
        replay: [
          ...match.replay,
          {
            turn,
            actions: {
              [challenge.challengerAgentId]: challengerSubmit.action,
              [challenge.opponentAgentId]: opponentSubmit.action
            },
            states: [stateA, stateB]
          }
        ],
        scorecardHash: match.scorecardHash
      };

      store.saveMatch(updatedMatch);

      const escrow = { txHash: null as string | null, error: null as string | null };

      if (matchOver) {
        return reply.send(await finalizeChallengeFromMatch({
          challengeId,
          challenge,
          opponentAgentId: challenge.opponentAgentId,
          match: updatedMatch,
          escrowTxHash: escrow.txHash,
          escrowError: escrow.error
        }));
      }

      return {
        ok: true,
        mode: 'simple',
        challenge,
        match: {
          ...updatedMatch,
          matchIdHex: toMatchIdHex(updatedMatch.id)
        },
        round: {
          turn: turn + 1,
          submittedBy: [],
          awaiting: [challenge.challengerAgentId, challenge.opponentAgentId]
        },
        states: [stateA, stateB],
        escrow: {
          mode: challenge.stake.mode,
          txHash: escrow.txHash ?? null,
          error: escrow.error
        },
        message: `Turn ${turn} resolved. Next turn: ${turn + 1}`
      };
    }

    return {
      ok: true,
      mode: 'simple',
      challenge,
      match: {
        ...match,
        matchIdHex: toMatchIdHex(match.id)
      },
      round: {
        turn,
        submittedBy: allSubmissions.map((s) => s.agentId),
        awaiting: [challenge.challengerAgentId, challenge.opponentAgentId].filter(
          (id) => !allSubmissions.some((s) => s.agentId === id)
        )
      },
      states: currentStatesFromMatch(match),
      message: `Turn ${turn} waiting for opponent action`
    };
  });

  app.get('/challenges/:id/state', async (req, reply) => {
    if (!requireRole(req, reply, 'readonly')) return;

    const challengeId = (req.params as { id: string }).id;
    const challenge = store.getChallenge(challengeId);
    if (!challenge) return reply.code(404).send({ error: 'not_found' });

    const match = challenge.matchId ? store.getMatch(challenge.matchId) : undefined;

    if (!match) {
      return { ok: true, challenge, match: null };
    }

    const submissions: Record<number, Array<{ agentId: string; action: AgentAction }>> = {};
    for (let t = 1; t <= match.turnsPlayed; t++) {
      const turnSubs = store.getChallengeRoundSubmissions(challengeId, t);
      submissions[t] = turnSubs.map((s) => ({ agentId: s.agentId, action: s.action }));
    }

    return {
      ok: true,
      challenge,
      match: {
        ...match,
        matchIdHex: toMatchIdHex(match.id)
      },
      submissions,
      states: match.replay.length > 0 ? match.replay[match.replay.length - 1].states : null
    };
  });
}
