import { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { runMatch } from '../engine/combatEngine.js';
import { toMatchIdHex } from '../utils/ids.js';
import { requireRole, resolveAccessRole, authSummary } from '../services/access.js';
import { fundOnSepolia, payoutOnSepolia } from '../services/payout.js';
import { createEscrowMatch, getEscrowMatchStatus, settleEscrowMatch } from '../services/escrow.js';
import { signMatchAttestation, verifyMatchAttestation } from '../services/attestation.js';
import { autoResolveMarketsForMatch } from '../services/markets.js';
import {
  endpointExecutionRequiredByDefault,
  evaluateStrictSandboxPolicy,
  sandboxParityRequiredByDefault,
  toMatchFairnessAudit
} from '../services/fairness.js';
import { RegisteredAgent, store } from '../services/store.js';
import { MatchFairnessAudit } from '../types/domain.js';

const agentSchema = z.object({
  id: z.string(),
  name: z.string(),
  endpoint: z.string().url(),
  apiKey: z.string().optional(),
  payoutAddress: z.string().optional()
});

const createSchema = z.object({
  agents: z.array(agentSchema).length(2).optional(),
  agentIds: z.tuple([z.string(), z.string()]).optional(),
  config: z.object({
    maxTurns: z.number().int().min(1).max(200),
    seed: z.number().int(),
    attackCost: z.number().int().min(1),
    attackDamage: z.number().int().min(1)
  }).default({ maxTurns: 30, seed: 1, attackCost: 1, attackDamage: 4 }),
  fairness: z.object({
    requireSandboxParity: z.boolean().optional()
  }).optional(),
  payout: z.object({ enabled: z.boolean().default(false), contractAddress: z.string().optional() }).optional()
}).refine((val) => Boolean(val.agents) || Boolean(val.agentIds), {
  message: 'Provide either agents or agentIds'
});

function parseOrReply<T extends z.ZodTypeAny>(schema: T, input: unknown, reply: FastifyReply): z.infer<T> | null {
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    reply.code(400).send({ error: 'invalid_request', issues: parsed.error.issues });
    return null;
  }
  return parsed.data;
}

function resolveAgentsFromRequest(body: z.infer<typeof createSchema>): {
  agents: z.infer<typeof agentSchema>[];
  registryAgents?: RegisteredAgent[];
} | null {
  if (body.agents?.length === 2) {
    return { agents: body.agents };
  }

  const ids = body.agentIds;
  if (!ids) return null;

  const resolved = ids.map((id) => store.getAgent(id));
  if (resolved.some((agent) => !agent || !agent.enabled)) return null;

  const registryAgents = resolved as RegisteredAgent[];

  return {
    registryAgents,
    agents: registryAgents.map((agent) => ({
      id: agent.id,
      name: agent.name,
      endpoint: agent.endpoint,
      apiKey: agent.apiKey,
      payoutAddress: agent.payoutAddress
    }))
  };
}

async function attestMatch(matchId: string) {
  const match = store.getMatch(matchId);
  if (!match) return null;

  const attestation = await signMatchAttestation(match);
  if (!attestation) return null;

  store.saveMatchAttestation(attestation);
  return attestation;
}

export async function matchRoutes(app: FastifyInstance) {
  app.get('/matches', async (req, reply) => {
    if (!requireRole(req, reply, 'readonly')) return;
    return store.listMatches().map((m) => ({
      id: m.id,
      matchIdHex: toMatchIdHex(m.id),
      status: m.status,
      winner: m.winner,
      outcome: m.winner ? 'decisive' : 'draw',
      startedAt: m.startedAt,
      turnsPlayed: m.turnsPlayed
    }));
  });

  app.get('/matches/:id', async (req, reply) => {
    if (!requireRole(req, reply, 'readonly')) return;
    const id = (req.params as { id: string }).id;
    const m = store.getMatch(id);
    if (!m) return reply.code(404).send({ error: 'not_found' });

    const attestation = store.getMatchAttestation(id);
    return {
      ...m,
      outcome: m.winner ? 'decisive' : 'draw',
      matchIdHex: toMatchIdHex(m.id),
      attestation: attestation ?? null
    };
  });

  app.get('/matches/:id/attestation', async (req, reply) => {
    if (!requireRole(req, reply, 'readonly')) return;

    const id = (req.params as { id: string }).id;
    const match = store.getMatch(id);
    if (!match) return reply.code(404).send({ error: 'not_found' });

    const attestation = store.getMatchAttestation(id);
    if (!attestation) {
      return reply.code(404).send({ error: 'attestation_not_found' });
    }

    const verification = verifyMatchAttestation(attestation, match);

    return {
      ok: true,
      matchId: id,
      matchIdHex: toMatchIdHex(id),
      attestation,
      verification
    };
  });

  app.post('/matches', async (req, reply) => {
    if (!requireRole(req, reply, 'operator')) return;

    const parsed = parseOrReply(createSchema, req.body, reply);
    if (!parsed) return;

    const resolved = resolveAgentsFromRequest(parsed);
    if (!resolved || resolved.agents.length !== 2) {
      return reply.code(400).send({
        error: 'invalid_agents',
        message: 'Agents missing or disabled. Use valid agentIds or provide full agent payload.'
      });
    }

    if (!resolved.registryAgents) {
      return reply.code(400).send({
        error: 'registry_agents_required',
        message: 'Strict sandbox mode requires registered agentIds with sandbox + EigenCompute metadata.'
      });
    }

    const strictPolicy = evaluateStrictSandboxPolicy({
      agents: resolved.registryAgents,
      executionMode: 'endpoint',
      requireParity: sandboxParityRequiredByDefault(),
      endpointModeRequired: endpointExecutionRequiredByDefault()
    });

    const fairness: MatchFairnessAudit = toMatchFairnessAudit(strictPolicy);

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

    const id = `match_${Date.now()}`;
    const result = await runMatch({
      id,
      agents: resolved.agents,
      config: parsed.config,
      fairness
    });

    store.saveMatch(result);

    const attestation = await attestMatch(result.id);
    const marketResolution = autoResolveMarketsForMatch({
      matchId: result.id,
      winnerAgentId: result.winner
    });

    if (parsed.payout?.enabled && result.winner) {
      const winner = resolved.agents.find((a) => a.id === result.winner);
      const signerKey = process.env.PAYOUT_SIGNER_PRIVATE_KEY || process.env.OPERATOR_PRIVATE_KEY;
      if (winner?.payoutAddress && parsed.payout.contractAddress && process.env.SEPOLIA_RPC_URL && signerKey) {
        await payoutOnSepolia({
          contractAddress: parsed.payout.contractAddress,
          privateKey: signerKey,
          rpcUrl: process.env.SEPOLIA_RPC_URL,
          matchIdHex: toMatchIdHex(id),
          winner: winner.payoutAddress
        });
      }
    }

    return reply.code(201).send({
      ...result,
      matchIdHex: toMatchIdHex(result.id),
      attestation,
      marketResolution
    });
  });

  app.post('/matches/:id/fund', async (req, reply) => {
    if (!requireRole(req, reply, 'operator')) return;

    const id = (req.params as { id: string }).id;
    const parsed = parseOrReply(z.object({ contractAddress: z.string(), amountEth: z.string() }), req.body, reply);
    if (!parsed) return;

    const match = store.getMatch(id);
    if (!match) return reply.code(404).send({ error: 'not_found' });

    const signerKey = process.env.PAYOUT_SIGNER_PRIVATE_KEY || process.env.OPERATOR_PRIVATE_KEY;
    if (!process.env.SEPOLIA_RPC_URL || !signerKey) return reply.code(400).send({ error: 'missing_chain_config' });

    const receipt = await fundOnSepolia({
      contractAddress: parsed.contractAddress,
      privateKey: signerKey,
      rpcUrl: process.env.SEPOLIA_RPC_URL,
      matchIdHex: toMatchIdHex(id),
      amountEth: parsed.amountEth
    });

    return { ok: true, txHash: receipt?.hash ?? null };
  });

  app.post('/matches/:id/payout', async (req, reply) => {
    if (!requireRole(req, reply, 'operator')) return;

    const id = (req.params as { id: string }).id;
    const parsed = parseOrReply(z.object({ contractAddress: z.string(), winner: z.string() }), req.body, reply);
    if (!parsed) return;

    const match = store.getMatch(id);
    if (!match) return reply.code(404).send({ error: 'not_found' });

    const signerKey = process.env.PAYOUT_SIGNER_PRIVATE_KEY || process.env.OPERATOR_PRIVATE_KEY;
    if (!process.env.SEPOLIA_RPC_URL || !signerKey) return reply.code(400).send({ error: 'missing_chain_config' });

    const receipt = await payoutOnSepolia({
      contractAddress: parsed.contractAddress,
      privateKey: signerKey,
      rpcUrl: process.env.SEPOLIA_RPC_URL,
      matchIdHex: toMatchIdHex(id),
      winner: parsed.winner
    });

    return { ok: true, txHash: receipt?.hash ?? null };
  });

  app.post('/matches/:id/escrow/create', async (req, reply) => {
    if (!requireRole(req, reply, 'operator')) return;

    const id = (req.params as { id: string }).id;
    const parsed = parseOrReply(z.object({
      contractAddress: z.string(),
      playerA: z.string(),
      playerB: z.string(),
      amountPerPlayer: z.string()
    }), req.body, reply);
    if (!parsed) return;

    const signerKey = process.env.PAYOUT_SIGNER_PRIVATE_KEY || process.env.OPERATOR_PRIVATE_KEY;
    if (!process.env.SEPOLIA_RPC_URL || !signerKey) return reply.code(400).send({ error: 'missing_chain_config' });

    const receipt = await createEscrowMatch({
      rpcUrl: process.env.SEPOLIA_RPC_URL,
      privateKey: signerKey,
      contractAddress: parsed.contractAddress,
      matchIdHex: toMatchIdHex(id),
      playerA: parsed.playerA,
      playerB: parsed.playerB,
      amountPerPlayer: parsed.amountPerPlayer
    });

    return { ok: true, txHash: receipt?.hash ?? null };
  });

  app.post('/matches/:id/escrow/settle', async (req, reply) => {
    if (!requireRole(req, reply, 'operator')) return;

    const id = (req.params as { id: string }).id;
    const parsed = parseOrReply(z.object({ contractAddress: z.string(), winner: z.string() }), req.body, reply);
    if (!parsed) return;

    const signerKey = process.env.PAYOUT_SIGNER_PRIVATE_KEY || process.env.OPERATOR_PRIVATE_KEY;
    if (!process.env.SEPOLIA_RPC_URL || !signerKey) return reply.code(400).send({ error: 'missing_chain_config' });

    const receipt = await settleEscrowMatch({
      rpcUrl: process.env.SEPOLIA_RPC_URL,
      privateKey: signerKey,
      contractAddress: parsed.contractAddress,
      matchIdHex: toMatchIdHex(id),
      winner: parsed.winner
    });

    return { ok: true, txHash: receipt?.hash ?? null };
  });

  app.get('/matches/:id/escrow/status', async (req, reply) => {
    if (!requireRole(req, reply, 'readonly')) return;

    const id = (req.params as { id: string }).id;
    const parsed = parseOrReply(z.object({ contractAddress: z.string() }), req.query, reply);
    if (!parsed) return;

    if (!process.env.SEPOLIA_RPC_URL) return reply.code(400).send({ error: 'missing_chain_config' });

    const status = await getEscrowMatchStatus({
      rpcUrl: process.env.SEPOLIA_RPC_URL,
      contractAddress: parsed.contractAddress,
      matchIdHex: toMatchIdHex(id)
    });

    return {
      ok: true,
      matchId: id,
      matchIdHex: toMatchIdHex(id),
      contractAddress: parsed.contractAddress,
      ...status
    };
  });

  app.get('/verification/eigencompute', async (req, reply) => {
    if (!requireRole(req, reply, 'readonly')) return;

    const appIds = [
      process.env.ECLOUD_APP_ID_API,
      process.env.ECLOUD_APP_ID_WEB,
      process.env.ECLOUD_APP_ID,
      ...(process.env.ECLOUD_APP_IDS ? process.env.ECLOUD_APP_IDS.split(',').map((v) => v.trim()) : [])
    ].filter(Boolean);

    const environment = process.env.ECLOUD_ENV || 'sepolia';
    const verifyUrl = environment === 'mainnet-alpha'
      ? 'https://verify.eigencloud.xyz/'
      : 'https://verify-sepolia.eigencloud.xyz/';

    return {
      ok: true,
      environment,
      appIds,
      verifyUrl,
      contracts: {
        prizePool: process.env.MOLT_PRIZE_POOL_ADDRESS || null,
        usdcEscrow: process.env.MOLT_USDC_ESCROW_ADDRESS || null
      },
      checks: {
        chainConfigLoaded: Boolean(process.env.SEPOLIA_RPC_URL),
        signerLoaded: Boolean(process.env.PAYOUT_SIGNER_PRIVATE_KEY || process.env.OPERATOR_PRIVATE_KEY),
        attestationSignerLoaded: Boolean(process.env.MATCH_ATTESTATION_SIGNER_PRIVATE_KEY || process.env.PAYOUT_SIGNER_PRIVATE_KEY || process.env.OPERATOR_PRIVATE_KEY),
        appBound: appIds.length > 0,
        contractsBound: Boolean(process.env.MOLT_PRIZE_POOL_ADDRESS),
        strictMode: {
          requireEndpointMode: endpointExecutionRequiredByDefault(),
          requireSandboxParity: sandboxParityRequiredByDefault(),
          requireEigenCompute: process.env.MATCH_REQUIRE_EIGENCOMPUTE !== 'false',
          allowSimpleMode: process.env.MATCH_ALLOW_SIMPLE_MODE === 'true'
        }
      }
    };
  });

  app.get('/auth/status', async (req) => {
    return {
      ok: true,
      role: resolveAccessRole(req),
      config: authSummary()
    };
  });
}
