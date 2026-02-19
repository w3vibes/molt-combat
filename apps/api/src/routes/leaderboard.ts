import { FastifyInstance } from 'fastify';
import { requireRole } from '../services/access.js';
import { verifyMatchAttestation } from '../services/attestation.js';
import { isStrictSandboxMatch } from '../services/fairness.js';
import { store } from '../services/store.js';

export async function leaderboardRoutes(app: FastifyInstance) {
  app.get('/leaderboard/trusted', async (req, reply) => {
    if (!requireRole(req, reply, 'readonly')) return;

    const query = req.query as { limit?: string };
    const limitRaw = Number(query.limit ?? 200);
    const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(Math.floor(limitRaw), 2000)) : 200;

    const allMatches = store
      .listMatches()
      .filter((match) => match.status === 'finished')
      .slice(0, limit);

    const attestations = new Map(
      store.listMatchAttestations().map((attestation) => [attestation.matchId, attestation])
    );

    const trustedMatches = allMatches.filter((match) => {
      const attestation = attestations.get(match.id);
      if (!attestation) return false;
      if (!match.winner) return false;
      if (!isStrictSandboxMatch(match)) return false;
      return verifyMatchAttestation(attestation, match).valid;
    });

    const aggregate = new Map<string, {
      agentId: string;
      wins: number;
      losses: number;
      matches: number;
      lastMatchAt: string;
      lastWinAt?: string;
    }>();

    for (const match of trustedMatches) {
      for (const agent of match.agents) {
        const row = aggregate.get(agent.id) ?? {
          agentId: agent.id,
          wins: 0,
          losses: 0,
          matches: 0,
          lastMatchAt: match.startedAt
        };

        row.matches += 1;
        if (Date.parse(match.startedAt) > Date.parse(row.lastMatchAt)) {
          row.lastMatchAt = match.startedAt;
        }

        if (match.winner === agent.id) {
          row.wins += 1;
          row.lastWinAt = row.lastWinAt && Date.parse(row.lastWinAt) > Date.parse(match.startedAt)
            ? row.lastWinAt
            : match.startedAt;
        } else if (match.winner) {
          row.losses += 1;
        }

        aggregate.set(agent.id, row);
      }
    }

    const leaderboard = [...aggregate.values()]
      .map((row) => ({
        ...row,
        winRate: row.matches > 0 ? Number(((row.wins / row.matches) * 100).toFixed(2)) : 0
      }))
      .sort((a, b) => {
        if (b.wins !== a.wins) return b.wins - a.wins;
        if (b.winRate !== a.winRate) return b.winRate - a.winRate;
        return a.agentId.localeCompare(b.agentId);
      });

    return {
      ok: true,
      strictOnly: true,
      trustedMatchCount: trustedMatches.length,
      evaluatedMatchCount: allMatches.length,
      leaderboard,
      generatedAt: new Date().toISOString()
    };
  });
}
