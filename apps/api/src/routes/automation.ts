import { FastifyInstance } from 'fastify';
import { requireRole } from '../services/access.js';
import {
  escrowAutomationStatus,
  runEscrowSettlementTick,
  startEscrowSettlementPolling,
  stopEscrowSettlementPolling
} from '../services/automation.js';

export async function automationRoutes(app: FastifyInstance) {
  app.get('/automation/status', async (req, reply) => {
    if (!requireRole(req, reply, 'readonly')) return;
    return {
      ok: true,
      automation: escrowAutomationStatus()
    };
  });

  app.post('/automation/tick', async (req, reply) => {
    if (!requireRole(req, reply, 'operator')) return;
    const summary = await runEscrowSettlementTick('manual_endpoint');
    return { ok: true, summary };
  });

  app.post('/automation/start', async (req, reply) => {
    if (!requireRole(req, reply, 'operator')) return;
    return {
      ok: true,
      ...startEscrowSettlementPolling(),
      automation: escrowAutomationStatus()
    };
  });

  app.post('/automation/stop', async (req, reply) => {
    if (!requireRole(req, reply, 'operator')) return;
    return {
      ok: true,
      ...stopEscrowSettlementPolling(),
      automation: escrowAutomationStatus()
    };
  });
}
