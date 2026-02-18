// import Fastify from 'fastify';
// const app = Fastify();
// app.post('/decide', async (req) => {
//   const { self, opponent } = req.body;
//   if (self.wallet.energy < 3) return { type: 'gather', resource: 'energy', amount: 3 };
//   if (opponent.hp > 20) return { type: 'attack', targetAgentId: opponent.agentId, amount: 3 };
//   return { type: 'hold' };
// });
// app.listen({ port: 4001, host: '0.0.0.0' });

import Fastify from 'fastify';

const app = Fastify({ logger: true });
const NAME = process.env.AGENT_NAME || 'Agent';
const STRATEGY = process.env.STRATEGY || 'balanced';

app.get('/health', async () => ({ ok: true, name: NAME, strategy: STRATEGY }));

app.post('/decide', async (req) => {
  const { self, opponent } = req.body || {};

  if (!self || !opponent) {
    return { type: 'hold' };
  }

  // simple deterministic strategy variants
  if (STRATEGY === 'aggressive') {
    if ((self.wallet?.energy ?? 0) >= 2) {
      return { type: 'attack', targetAgentId: opponent.agentId, amount: 2 };
    }
    return { type: 'gather', resource: 'energy', amount: 3 };
  }

  if (STRATEGY === 'defensive') {
    if ((self.hp ?? 100) < 50) {
      return { type: 'gather', resource: 'energy', amount: 3 };
    }
    if ((self.wallet?.energy ?? 0) >= 2) {
      return { type: 'attack', targetAgentId: opponent.agentId, amount: 1 };
    }
    return { type: 'hold' };
  }

  // balanced default
  if ((self.wallet?.energy ?? 0) < 2) {
    return { type: 'gather', resource: 'energy', amount: 2 };
  }
  return { type: 'attack', targetAgentId: opponent.agentId, amount: 1 };
});

app.listen({ port: 4001, host: '0.0.0.0' });