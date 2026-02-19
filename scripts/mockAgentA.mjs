import Fastify from 'fastify';
import { createHash } from 'node:crypto';

const app = Fastify({ logger: { level: process.env.LOG_LEVEL || 'info' } });

const PROFILE = {
  name: process.env.AGENT_NAME || 'Vanguard-A',
  style: 'adaptive-aggression',
  aggression: Number(process.env.AGGRESSION || 0.78),
  economyBias: Number(process.env.ECONOMY_BIAS || 0.34),
  riskTolerance: Number(process.env.RISK_TOLERANCE || 0.66)
};

const SESSIONS = new Map();

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function toInt(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.floor(n) : fallback;
}

function normalizeWallet(input = {}) {
  return {
    energy: clamp(toInt(input.energy, 0), 0, 10_000),
    metal: clamp(toInt(input.metal, 0), 0, 10_000),
    data: clamp(toInt(input.data, 0), 0, 10_000)
  };
}

function normalizeState(input) {
  if (!input || typeof input !== 'object') return null;
  const state = {
    agentId: typeof input.agentId === 'string' && input.agentId.trim() ? input.agentId.trim() : null,
    hp: clamp(toInt(input.hp, 100), 0, 1_000),
    score: clamp(toInt(input.score, 0), -1_000, 1_000_000),
    wallet: normalizeWallet(input.wallet)
  };
  if (!state.agentId) return null;
  return state;
}

function normalizeConfig(input = {}) {
  return {
    maxTurns: clamp(toInt(input.maxTurns, 30), 1, 500),
    seed: toInt(input.seed, 1),
    attackCost: clamp(toInt(input.attackCost, 1), 1, 50),
    attackDamage: clamp(toInt(input.attackDamage, 4), 1, 100)
  };
}

function normalizePayload(body) {
  if (!body || typeof body !== 'object') return null;
  const self = normalizeState(body.self);
  const opponent = normalizeState(body.opponent);
  if (!self || !opponent) return null;

  const turn = clamp(toInt(body.turn, 1), 1, 10_000);
  const config = normalizeConfig(body.config || {});

  return { turn, self, opponent, config };
}

function hashNumber(input) {
  const hex = createHash('sha256').update(input).digest('hex').slice(0, 12);
  return Number.parseInt(hex, 16);
}

function cloneState(state) {
  return {
    agentId: state.agentId,
    hp: state.hp,
    score: state.score,
    wallet: {
      energy: state.wallet.energy,
      metal: state.wallet.metal,
      data: state.wallet.data
    }
  };
}

function actionKey(action) {
  if (!action) return 'hold';
  if (action.type === 'attack') return `attack:${action.amount}`;
  if (action.type === 'gather') return `gather:${action.resource}:${action.amount}`;
  if (action.type === 'trade') return `trade:${action.give}:${action.receive}:${action.amount}`;
  return 'hold';
}

function applyAction(actor, enemy, action, cfg) {
  if (action.type === 'hold') return;

  if (action.type === 'gather') {
    const amount = clamp(toInt(action.amount, 1), 1, 10);
    actor.wallet[action.resource] += amount;
    actor.score += 1;
    return;
  }

  if (action.type === 'trade') {
    const amount = clamp(toInt(action.amount, 1), 1, 10);
    if (actor.wallet[action.give] >= amount) {
      actor.wallet[action.give] -= amount;
      actor.wallet[action.receive] += amount;
      actor.score += 2;
    }
    return;
  }

  if (action.type === 'attack') {
    const amount = clamp(toInt(action.amount, 1), 1, 10);
    const cost = amount * cfg.attackCost;
    if (actor.wallet.energy >= cost) {
      actor.wallet.energy -= cost;
      enemy.hp = Math.max(0, enemy.hp - amount * cfg.attackDamage);
      actor.score += 3;
    }
  }
}

function inferOpponentAction(previous, snapshot, cfg) {
  if (!previous) return { type: 'unknown' };

  const pOpp = previous.opponent;
  const cOpp = snapshot.opponent;
  const pSelf = previous.self;
  const cSelf = snapshot.self;

  const scoreDelta = cOpp.score - pOpp.score;
  const hpDeltaSelf = cSelf.hp - pSelf.hp;

  if (scoreDelta >= 3 && hpDeltaSelf < 0) {
    const estimatedAmount = clamp(Math.round((-hpDeltaSelf) / Math.max(cfg.attackDamage, 1)), 1, 10);
    return { type: 'attack', amount: estimatedAmount };
  }

  if (scoreDelta >= 2) {
    return { type: 'trade' };
  }

  if (scoreDelta >= 1) {
    return { type: 'gather' };
  }

  return { type: 'hold' };
}

function sessionKey(snapshot) {
  return `${snapshot.self.agentId}::${snapshot.opponent.agentId}::${snapshot.config.seed}`;
}

function getSession(snapshot) {
  const key = sessionKey(snapshot);
  let session = SESSIONS.get(key);
  if (!session) {
    session = {
      key,
      seenTurns: 0,
      opponentActions: {
        attack: 0,
        gather: 0,
        trade: 0,
        hold: 0,
        unknown: 0
      },
      previous: null,
      recentDecisions: []
    };
    SESSIONS.set(key, session);
  }
  return session;
}

function updateSession(session, snapshot) {
  const inferred = inferOpponentAction(session.previous, snapshot, snapshot.config);
  const type = inferred.type || 'unknown';
  session.opponentActions[type] = (session.opponentActions[type] || 0) + 1;
  session.seenTurns += 1;
  session.previous = {
    self: cloneState(snapshot.self),
    opponent: cloneState(snapshot.opponent)
  };
  return inferred;
}

function predictedOpponentAggression(session) {
  const counts = session.opponentActions;
  const total = counts.attack + counts.gather + counts.trade + counts.hold;
  if (total <= 0) return 0.5;
  return counts.attack / total;
}

function predictOpponentAction(snapshot, session) {
  const { opponent, self, config, turn } = snapshot;
  const aggression = predictedOpponentAggression(session);

  const feasible = Math.floor(opponent.wallet.energy / config.attackCost);
  const lethalNeeded = Math.ceil(self.hp / config.attackDamage);

  if (feasible >= lethalNeeded && lethalNeeded > 0) {
    return { type: 'attack', targetAgentId: self.agentId, amount: clamp(lethalNeeded, 1, 10) };
  }

  if (opponent.wallet.energy < config.attackCost) {
    if (opponent.wallet.data >= 2) {
      return { type: 'trade', give: 'data', receive: 'energy', amount: clamp(opponent.wallet.data, 1, 4) };
    }
    if (opponent.wallet.metal >= 2) {
      return { type: 'trade', give: 'metal', receive: 'energy', amount: clamp(opponent.wallet.metal, 1, 4) };
    }
    return { type: 'gather', resource: 'energy', amount: 3 };
  }

  const finalStretch = turn >= snapshot.config.maxTurns - 2;
  if (finalStretch || aggression > 0.44 || self.hp < 40) {
    return { type: 'attack', targetAgentId: self.agentId, amount: clamp(Math.max(1, Math.min(5, feasible)), 1, 10) };
  }

  if (opponent.wallet.energy < config.attackCost * 2) {
    return { type: 'gather', resource: 'energy', amount: 2 };
  }

  return { type: 'attack', targetAgentId: self.agentId, amount: clamp(Math.max(1, Math.min(3, feasible)), 1, 10) };
}

function pushUnique(candidates, action) {
  const key = actionKey(action);
  if (candidates.some((item) => actionKey(item) === key)) return;
  candidates.push(action);
}

function buildCandidates(snapshot) {
  const { self, opponent, config, turn } = snapshot;
  const candidates = [];

  pushUnique(candidates, { type: 'hold' });

  const feasibleAttack = Math.floor(self.wallet.energy / config.attackCost);
  if (feasibleAttack > 0) {
    const lethalNeeded = Math.ceil(opponent.hp / config.attackDamage);
    if (lethalNeeded <= feasibleAttack) {
      pushUnique(candidates, {
        type: 'attack',
        targetAgentId: opponent.agentId,
        amount: clamp(lethalNeeded, 1, 10)
      });
    }

    const ladder = [feasibleAttack, Math.ceil(feasibleAttack * 0.7), Math.ceil(feasibleAttack * 0.4), 1]
      .map((value) => clamp(value, 1, 10));

    for (const amount of ladder) {
      pushUnique(candidates, {
        type: 'attack',
        targetAgentId: opponent.agentId,
        amount
      });
    }
  }

  const turnsRemaining = config.maxTurns - turn;
  const neededEnergy = Math.max(config.attackCost * (turnsRemaining > 3 ? 4 : 2), config.attackCost);
  if (self.wallet.energy < neededEnergy) {
    pushUnique(candidates, {
      type: 'gather',
      resource: 'energy',
      amount: clamp(neededEnergy - self.wallet.energy, 1, 4)
    });
  }

  pushUnique(candidates, {
    type: 'gather',
    resource: 'data',
    amount: 2
  });

  if (self.wallet.data >= 2) {
    pushUnique(candidates, {
      type: 'trade',
      give: 'data',
      receive: 'energy',
      amount: clamp(self.wallet.data, 1, 5)
    });
  }

  if (self.wallet.metal >= 2) {
    pushUnique(candidates, {
      type: 'trade',
      give: 'metal',
      receive: 'energy',
      amount: clamp(self.wallet.metal, 1, 4)
    });
  }

  return candidates;
}

function scoreState(state, snapshot, session) {
  const { self, opponent, config, turn } = state;
  const turnsRemaining = Math.max(0, snapshot.config.maxTurns - turn);

  const hpDiff = self.hp - opponent.hp;
  const scoreDiff = self.score - opponent.score;
  const energyDiff = self.wallet.energy - opponent.wallet.energy;
  const economyDiff = (self.wallet.metal + self.wallet.data) - (opponent.wallet.metal + opponent.wallet.data);

  const endgameMultiplier = turnsRemaining <= 2 ? 1.55 : 1;
  const pressureMultiplier = turnsRemaining <= 5 ? 1.2 : 1;

  let value = 0;
  value += hpDiff * 7.1 * endgameMultiplier;
  value += scoreDiff * 2.6 * pressureMultiplier;
  value += energyDiff * 1.25;
  value += economyDiff * PROFILE.economyBias;

  const feasibleEnemyAttack = Math.floor(opponent.wallet.energy / config.attackCost);
  const incomingDamage = feasibleEnemyAttack * config.attackDamage;
  value -= incomingDamage * (1 - PROFILE.riskTolerance * 0.55);

  const aggressionSeen = predictedOpponentAggression(session);
  value += aggressionSeen * 1.8;

  if (opponent.hp <= 0) value += 50_000;
  if (self.hp <= 0) value -= 50_000;

  return value;
}

function evaluateAction(snapshot, action, session) {
  const self = cloneState(snapshot.self);
  const opponent = cloneState(snapshot.opponent);
  const cfg = snapshot.config;

  applyAction(self, opponent, action, cfg);

  const predictedOppAction = predictOpponentAction(
    {
      ...snapshot,
      self,
      opponent
    },
    session
  );

  applyAction(opponent, self, predictedOppAction, cfg);

  const nextState = {
    self,
    opponent,
    config: cfg,
    turn: snapshot.turn + 1
  };

  let score = scoreState(nextState, snapshot, session);

  if (action.type === 'attack') {
    score += action.amount * PROFILE.aggression * 1.4;
  }

  if (action.type === 'hold') {
    score -= 0.8;
  }

  return {
    action,
    score,
    predictedOppAction
  };
}

function selectBest(snapshot, session) {
  const candidates = buildCandidates(snapshot);
  const evaluated = candidates.map((action) => evaluateAction(snapshot, action, session));

  evaluated.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;

    const pa = a.action.type === 'attack' ? 3 : a.action.type === 'trade' ? 2 : a.action.type === 'gather' ? 1 : 0;
    const pb = b.action.type === 'attack' ? 3 : b.action.type === 'trade' ? 2 : b.action.type === 'gather' ? 1 : 0;
    if (pb !== pa) return pb - pa;

    const ta = hashNumber(`${snapshot.self.agentId}:${snapshot.turn}:${actionKey(a.action)}`);
    const tb = hashNumber(`${snapshot.self.agentId}:${snapshot.turn}:${actionKey(b.action)}`);
    return tb - ta;
  });

  return evaluated[0]?.action ?? { type: 'hold' };
}

function decide(snapshot) {
  const session = getSession(snapshot);
  updateSession(session, snapshot);

  const action = selectBest(snapshot, session);

  session.recentDecisions.push({ turn: snapshot.turn, action: actionKey(action) });
  if (session.recentDecisions.length > 20) session.recentDecisions.shift();

  return action;
}

app.get('/health', async () => ({
  ok: true,
  name: PROFILE.name,
  style: PROFILE.style,
  activeSessions: SESSIONS.size
}));

app.get('/profile', async () => ({
  ok: true,
  profile: PROFILE,
  notes: 'Adaptive aggressive endpoint with prediction + metered-state optimization'
}));

app.post('/decide', async (req) => {
  try {
    const snapshot = normalizePayload(req.body);
    if (!snapshot) return { type: 'hold' };

    const action = decide(snapshot);
    return action;
  } catch (error) {
    req.log.error({ error }, 'decision_failure_fallback_hold');
    return { type: 'hold' };
  }
});

const port = Number(process.env.PORT || 4001);
app.listen({ port, host: '0.0.0.0' })
  .then(() => app.log.info({ name: PROFILE.name, port }, 'agent_endpoint_ready'))
  .catch((error) => {
    app.log.error(error);
    process.exit(1);
  });
