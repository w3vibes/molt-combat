#!/usr/bin/env node
import { execSync } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';

function run(cmd) {
  try {
    return { ok: true, output: execSync(cmd, { stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim() };
  } catch (e) {
    const out = (e.stdout?.toString?.() || '').trim();
    const err = (e.stderr?.toString?.() || '').trim();
    return { ok: false, output: [out, err].filter(Boolean).join('\n') || String(e.message || e) };
  }
}

const cliArgs = process.argv.slice(2).filter(Boolean);
const envIds = [
  ...(process.env.ECLOUD_APP_IDS ? process.env.ECLOUD_APP_IDS.split(',').map((v) => v.trim()).filter(Boolean) : []),
  process.env.ECLOUD_APP_ID_API,
  process.env.ECLOUD_APP_ID_WEB,
  process.env.ECLOUD_APP_ID
].filter(Boolean);

const appIds = [...new Set([...cliArgs, ...envIds])];

if (appIds.length === 0) {
  console.error('Usage: npm run verify:tee -- <appId> [appId2 ...] or set ECLOUD_APP_ID(S) in .env');
  process.exit(1);
}

const snapshot = {
  timestamp: new Date().toISOString(),
  appIds,
  whoami: run('ecloud auth whoami'),
  environment: run('ecloud compute env show'),
  apps: []
};

for (const appId of appIds) {
  snapshot.apps.push({
    appId,
    info: run(`ecloud compute app info ${appId}`),
    releases: run(`ecloud compute app releases ${appId} --json`)
  });
}

mkdirSync('artifacts', { recursive: true });
const path = `artifacts/eigencompute-verification-${Date.now()}.json`;
writeFileSync(path, JSON.stringify(snapshot, null, 2));
console.log(`Saved verification artifact: ${path}`);
