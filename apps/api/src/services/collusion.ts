import type { MatchRecord } from '../types/domain.js';
import type { CollusionRiskResult } from './fairness.js';

function boundedNumber(value: string | undefined, fallback: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return Math.min(Math.floor(parsed), max);
}

export function collusionWindowHours(): number {
  return boundedNumber(process.env.MATCH_COLLUSION_WINDOW_HOURS, 24, 24 * 30);
}

export function collusionMaxHeadToHead(): number {
  return boundedNumber(process.env.MATCH_COLLUSION_MAX_HEAD_TO_HEAD, 12, 500);
}

export function collusionMinDecisiveForDominance(): number {
  return boundedNumber(process.env.MATCH_COLLUSION_MIN_DECISIVE_FOR_DOMINANCE, 6, 500);
}

export function collusionMaxDominantWinRate(): number {
  const raw = Number(process.env.MATCH_COLLUSION_MAX_DOMINANT_WIN_RATE ?? 0.9);
  if (!Number.isFinite(raw)) return 0.9;
  return Math.min(Math.max(raw, 0.5), 1);
}

export function collusionPolicyConfig() {
  return {
    windowHours: collusionWindowHours(),
    maxHeadToHead: collusionMaxHeadToHead(),
    minDecisiveForDominance: collusionMinDecisiveForDominance(),
    maxDominantWinRate: collusionMaxDominantWinRate()
  };
}

function hasPair(match: MatchRecord, a: string, b: string): boolean {
  const ids = new Set(match.agents.map((agent) => agent.id));
  return ids.has(a) && ids.has(b) && ids.size === 2;
}

export function evaluateHeadToHeadCollusionRisk(params: {
  agentAId: string;
  agentBId: string;
  matches: MatchRecord[];
  required: boolean;
}): CollusionRiskResult {
  if (!params.required) {
    return {
      required: false,
      enforced: false,
      passed: true,
      reasons: []
    };
  }

  const policy = collusionPolicyConfig();
  const cutoff = Date.now() - policy.windowHours * 60 * 60 * 1000;

  const recent = params.matches
    .filter((match) => match.status === 'finished')
    .filter((match) => Date.parse(match.startedAt) >= cutoff)
    .filter((match) => hasPair(match, params.agentAId, params.agentBId));

  const decisive = recent.filter((match) => Boolean(match.winner));
  const winsA = decisive.filter((match) => match.winner === params.agentAId).length;
  const winsB = decisive.filter((match) => match.winner === params.agentBId).length;

  const reasons: string[] = [];

  if (recent.length > policy.maxHeadToHead) {
    reasons.push(`head_to_head_volume_exceeded:${recent.length}>${policy.maxHeadToHead}`);
  }

  const decisiveCount = decisive.length;
  const dominantWins = Math.max(winsA, winsB);
  const dominantAgentId = dominantWins === winsA ? params.agentAId : params.agentBId;
  const dominantWinRate = decisiveCount > 0 ? dominantWins / decisiveCount : 0;

  if (decisiveCount >= policy.minDecisiveForDominance && dominantWinRate >= policy.maxDominantWinRate) {
    reasons.push(`dominant_outcomes:${dominantAgentId}:${dominantWinRate.toFixed(3)}`);
  }

  return {
    required: true,
    enforced: true,
    passed: reasons.length === 0,
    reason: reasons.length > 0 ? `collusion_risk:${reasons.join(',')}` : undefined,
    reasons,
    metrics: {
      headToHeadMatches24h: recent.length,
      decisiveMatches24h: decisiveCount,
      dominantAgentId: decisiveCount > 0 ? dominantAgentId : undefined,
      dominantWinRate: decisiveCount > 0 ? Number(dominantWinRate.toFixed(4)) : undefined
    }
  };
}
