import {
  AgentAction,
  AgentProfile,
  AgentState,
  MatchAuditRecord,
  MatchConfig,
  MatchFairnessAudit,
  MatchRecord,
  MatchReplayTurn,
  Resource
} from '../types/domain.js';
import { requestActionMetered } from '../services/agentClient.js';
import { stableHash } from '../utils/hash.js';

function initialState(agentId: string): AgentState {
  return { agentId, hp: 100, score: 0, wallet: { energy: 5, metal: 5, data: 5 } };
}

function clamp(n: number, min: number, max: number): number { return Math.max(min, Math.min(max, n)); }

function applyGather(state: AgentState, resource: Resource, amount: number) {
  state.wallet[resource] += clamp(amount, 1, 10);
  state.score += 1;
}

function applyTrade(state: AgentState, give: Resource, receive: Resource, amount: number) {
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

function winner(a: AgentState, b: AgentState): string | undefined {
  if (a.hp === b.hp) {
    if (a.score === b.score) return undefined;
    return a.score > b.score ? a.agentId : b.agentId;
  }
  return a.hp > b.hp ? a.agentId : b.agentId;
}

function defaultFairnessAudit(): MatchFairnessAudit {
  return {
    sandboxParityRequired: false,
    sandboxParityEnforced: false,
    sandboxParityPassed: true
  };
}

function createAudit(fairness: MatchFairnessAudit): MatchAuditRecord {
  return {
    fairness,
    meteringTotals: {
      requestBytes: 0,
      responseBytes: 0,
      timeouts: 0,
      fallbackHolds: 0,
      invalidActions: 0
    }
  };
}

function addToMeteringTotals(audit: MatchAuditRecord, replayTurn: MatchReplayTurn) {
  const meteringEntries = replayTurn.metering ? Object.values(replayTurn.metering) : [];

  for (const item of meteringEntries) {
    audit.meteringTotals.requestBytes += item.requestBytes;
    audit.meteringTotals.responseBytes += item.responseBytes;
    if (item.timedOut) audit.meteringTotals.timeouts += 1;
    if (item.fallbackHold) audit.meteringTotals.fallbackHolds += 1;
    if (item.invalidAction) audit.meteringTotals.invalidActions += 1;
  }
}

export async function runMatch(input: {
  id: string;
  agents: AgentProfile[];
  config: MatchConfig;
  fairness?: MatchFairnessAudit;
}): Promise<MatchRecord> {
  const [aProf, bProf] = input.agents;
  const a = initialState(aProf.id);
  const b = initialState(bProf.id);
  const replay: MatchRecord['replay'] = [];

  const fairness = input.fairness ?? defaultFairnessAudit();
  const audit = createAudit(fairness);

  const record: MatchRecord = {
    id: input.id,
    status: 'running',
    startedAt: new Date().toISOString(),
    turnsPlayed: 0,
    agents: input.agents,
    replay,
    config: input.config,
    audit
  };

  for (let turn = 1; turn <= input.config.maxTurns; turn++) {
    const [aResult, bResult] = await Promise.all([
      requestActionMetered({
        agent: aProf,
        turn,
        self: structuredClone(a),
        opponent: structuredClone(b),
        config: input.config,
        sandboxParityEnforced: fairness.sandboxParityEnforced
      }),
      requestActionMetered({
        agent: bProf,
        turn,
        self: structuredClone(b),
        opponent: structuredClone(a),
        config: input.config,
        sandboxParityEnforced: fairness.sandboxParityEnforced
      })
    ]);

    const actions: Record<string, AgentAction> = { [a.agentId]: aResult.action, [b.agentId]: bResult.action };

    for (const [actor, action] of Object.entries(actions)) {
      const self = actor === a.agentId ? a : b;
      const other = actor === a.agentId ? b : a;
      if (action.type === 'gather') applyGather(self, action.resource, action.amount);
      if (action.type === 'trade') applyTrade(self, action.give, action.receive, action.amount);
      if (action.type === 'attack') applyAttack(self, other, action.amount, input.config);
    }

    const replayTurn: MatchReplayTurn = {
      turn,
      actions,
      states: [structuredClone(a), structuredClone(b)],
      metering: {
        [a.agentId]: aResult.metering,
        [b.agentId]: bResult.metering
      }
    };

    addToMeteringTotals(audit, replayTurn);

    replay.push(replayTurn);
    record.turnsPlayed = turn;
    if (a.hp <= 0 || b.hp <= 0) break;
  }

  record.winner = winner(a, b);
  record.status = 'finished';
  record.scorecardHash = stableHash({
    replay,
    winner: record.winner,
    turns: record.turnsPlayed,
    config: record.config,
    audit
  });
  return record;
}
