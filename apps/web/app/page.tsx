'use client';

import { useEffect, useMemo, useState } from 'react';
import { motion } from 'framer-motion';
import {
  Activity,
  Coins,
  PlayCircle,
  Rocket,
  ShieldCheck,
  Trophy,
  WalletCards,
  Wifi
} from 'lucide-react';
import { Bar, BarChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';

type MatchSummary = {
  id: string;
  matchIdHex?: string;
  status: string;
  winner?: string;
  startedAt: string;
  turnsPlayed: number;
};

type AgentProfile = {
  id: string;
  name: string;
  endpoint: string;
  apiKey?: string;
  payoutAddress?: string;
};

type RegisteredAgent = AgentProfile & {
  enabled: boolean;
  lastHealthStatus: 'unknown' | 'healthy' | 'unhealthy';
  lastHealthAt?: string;
  lastHealthError?: string;
};

type ReplayTurn = { turn: number; states: { agentId: string; hp: number; score: number }[] };

type MatchDetail = MatchSummary & {
  agents: AgentProfile[];
  replay: ReplayTurn[];
};

type Verification = {
  ok: boolean;
  environment: string;
  appIds: string[];
  verifyUrl: string;
  contracts?: { prizePool?: string | null; usdcEscrow?: string | null };
  checks: {
    chainConfigLoaded: boolean;
    signerLoaded: boolean;
    appBound: boolean;
    contractsBound?: boolean;
  };
};

type AuthStatus = {
  ok: boolean;
  role: 'public' | 'readonly' | 'agent' | 'operator' | 'admin';
  config: {
    allowPublicRead: boolean;
    hasAdminKey: boolean;
    hasOperatorKey: boolean;
    hasReadonlyKey: boolean;
    acceptsAgentApiKeys?: boolean;
  };
};

type EscrowStatus = {
  ok: boolean;
  matchId: string;
  matchIdHex: string;
  contractAddress: string;
  playerA: string;
  playerB: string;
  amountPerPlayer: string;
  settled: boolean;
  playerADeposited: boolean;
  playerBDeposited: boolean;
};

type Challenge = {
  id: string;
  topic: string;
  status: 'open' | 'accepted' | 'running' | 'awaiting_judgement' | 'completed' | 'cancelled';
  challengerAgentId: string;
  opponentAgentId?: string;
  matchId?: string;
  winnerAgentId?: string;
  stake: {
    mode: 'none' | 'usdc';
    contractAddress?: string;
    amountPerPlayer?: string;
    playerA?: string;
    playerB?: string;
  };
  createdAt: string;
  updatedAt: string;
};

const apiBase = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3000';
const API_KEY_STORAGE = 'moltcombat_api_key';

async function request<T>(path: string, apiKey: string, options?: RequestInit): Promise<T> {
  const headers: Record<string, string> = {
    ...(options?.headers as Record<string, string> | undefined)
  };

  if (options?.body && !headers['content-type']) {
    headers['content-type'] = 'application/json';
  }

  if (apiKey) {
    headers.authorization = `Bearer ${apiKey}`;
  }

  const res = await fetch(`${apiBase}${path}`, {
    ...options,
    headers
  });

  const text = await res.text();
  const json = text ? JSON.parse(text) : {};

  if (!res.ok) {
    throw new Error(json?.error || json?.message || `HTTP ${res.status}`);
  }

  return json as T;
}

export default function Page() {
  const [apiKey, setApiKey] = useState('');
  const [auth, setAuth] = useState<AuthStatus | null>(null);

  const [matches, setMatches] = useState<MatchSummary[]>([]);
  const [agents, setAgents] = useState<RegisteredAgent[]>([]);
  const [verification, setVerification] = useState<Verification | null>(null);

  const [selectedMatchId, setSelectedMatchId] = useState('');
  const [detail, setDetail] = useState<MatchDetail | null>(null);

  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('Ready');

  const [form, setForm] = useState({
    aId: 'alpha',
    aName: 'Alpha',
    aEndpoint: 'http://localhost:4001',
    aPayout: '',
    bId: 'beta',
    bName: 'Beta',
    bEndpoint: 'http://localhost:4002',
    bPayout: '',
    fromRegistryA: '',
    fromRegistryB: '',
    maxTurns: '10',
    attackCost: '1',
    attackDamage: '4'
  });

  const [agentForm, setAgentForm] = useState({
    id: '',
    name: '',
    endpoint: '',
    payoutAddress: '',
    apiKey: ''
  });

  const [ops, setOps] = useState({
    prizeContract: '',
    fundAmountEth: '0.001',
    payoutWinner: '',
    escrowContract: '',
    escrowPlayerA: '',
    escrowPlayerB: '',
    escrowAmountPerPlayer: '1000000',
    escrowWinner: ''
  });
  const [escrowStatus, setEscrowStatus] = useState<EscrowStatus | null>(null);

  const [challenges, setChallenges] = useState<Challenge[]>([]);
  const [challengeAcceptById, setChallengeAcceptById] = useState<Record<string, string>>({});
  const [challengeJudgeById, setChallengeJudgeById] = useState<Record<string, string>>({});

  const [challengeForm, setChallengeForm] = useState({
    topic: '',
    challengerAgentId: '',
    opponentAgentId: '',
    stakeMode: 'none' as 'none' | 'usdc',
    amountPerPlayer: '1000000',
    playerA: '',
    playerB: '',
    contractAddress: ''
  });

  useEffect(() => {
    const saved = localStorage.getItem(API_KEY_STORAGE);
    if (saved) setApiKey(saved);
  }, []);

  useEffect(() => {
    localStorage.setItem(API_KEY_STORAGE, apiKey);
  }, [apiKey]);

  async function refreshAll() {
    const [matchRes, verifyRes, authRes, agentRes, challengeRes] = await Promise.all([
      request<MatchSummary[]>('/matches', apiKey).catch(() => []),
      request<Verification>('/verification/eigencompute', apiKey).catch(() => null as unknown as Verification),
      request<AuthStatus>('/auth/status', apiKey).catch(() => null as unknown as AuthStatus),
      request<RegisteredAgent[]>('/agents?includeDisabled=true', apiKey).catch(() => []),
      request<{ ok: boolean; challenges: Challenge[] }>('/challenges', apiKey).catch(() => ({ ok: false, challenges: [] }))
    ]);

    setMatches(matchRes || []);
    setAgents(agentRes || []);
    setChallenges(challengeRes?.challenges || []);

    if (verifyRes) {
      setVerification(verifyRes);
      setOps((prev) => ({
        ...prev,
        prizeContract: prev.prizeContract || verifyRes.contracts?.prizePool || '',
        escrowContract: prev.escrowContract || verifyRes.contracts?.usdcEscrow || ''
      }));

      setChallengeForm((prev) => ({
        ...prev,
        contractAddress: prev.contractAddress || verifyRes.contracts?.usdcEscrow || ''
      }));
    }

    if (authRes) setAuth(authRes);
  }

  useEffect(() => {
    refreshAll();
    const timer = setInterval(() => refreshAll(), 8000);
    return () => clearInterval(timer);
  }, [apiKey]);

  useEffect(() => {
    if (!selectedMatchId) {
      setEscrowStatus(null);
      return;
    }

    setEscrowStatus(null);
    request<MatchDetail>(`/matches/${selectedMatchId}`, apiKey)
      .then((match) => {
        setDetail(match);

        const winnerAgent = match.winner ? match.agents.find((a) => a.id === match.winner) : undefined;
        setOps((prev) => ({
          ...prev,
          payoutWinner: prev.payoutWinner || winnerAgent?.payoutAddress || '',
          escrowWinner: prev.escrowWinner || winnerAgent?.payoutAddress || '',
          escrowPlayerA: prev.escrowPlayerA || match.agents[0]?.payoutAddress || '',
          escrowPlayerB: prev.escrowPlayerB || match.agents[1]?.payoutAddress || ''
        }));
      })
      .catch(() => setDetail(null));
  }, [selectedMatchId, apiKey]);

  const leaderboard = useMemo(() => {
    const score = new Map<string, number>();
    for (const match of matches) {
      if (!match.winner) continue;
      score.set(match.winner, (score.get(match.winner) ?? 0) + 1);
    }
    return [...score.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([agent, wins]) => ({ agent, wins }));
  }, [matches]);

  const enabledAgents = useMemo(() => agents.filter((a) => a.enabled), [agents]);
  const selectedMatch = useMemo(() => matches.find((match) => match.id === selectedMatchId), [matches, selectedMatchId]);

  useEffect(() => {
    if (enabledAgents.length === 0) return;

    setChallengeForm((prev) => ({
      ...prev,
      challengerAgentId: prev.challengerAgentId || enabledAgents[0].id,
      opponentAgentId: prev.opponentAgentId || enabledAgents[1]?.id || ''
    }));
  }, [enabledAgents]);

  async function runAction(name: string, fn: () => Promise<void>) {
    try {
      setBusy(true);
      setStatus(`${name}...`);
      await fn();
      await refreshAll();
      setStatus(`${name} ✅`);
    } catch (error) {
      setStatus(`${name} ❌ ${(error as Error).message}`);
    } finally {
      setBusy(false);
    }
  }

  function setAgentToSlot(slot: 'A' | 'B', agent: RegisteredAgent) {
    if (slot === 'A') {
      setForm((prev) => ({
        ...prev,
        fromRegistryA: agent.id,
        aId: agent.id,
        aName: agent.name,
        aEndpoint: agent.endpoint,
        aPayout: agent.payoutAddress || ''
      }));
      return;
    }

    setForm((prev) => ({
      ...prev,
      fromRegistryB: agent.id,
      bId: agent.id,
      bName: agent.name,
      bEndpoint: agent.endpoint,
      bPayout: agent.payoutAddress || ''
    }));
  }

  return (
    <main className="container space-y-6">
      <motion.section initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }}>
        <Card className="space-y-3">
          <div className="flex items-center gap-2 text-xl font-semibold">
            <Rocket size={20} /> MoltCombat — Launch Console
          </div>
          <p className="text-sm text-slate-300">
            Full operator console: agent registry, match orchestration, onchain settlement, and verification.
          </p>
          <div className="grid gap-2 md:grid-cols-3">
            <a className="rounded-lg bg-primary px-3 py-2 text-sm text-center" href={`${apiBase}/docs`} target="_blank">API Docs</a>
            <a className="rounded-lg border border-border px-3 py-2 text-sm text-center" href={verification?.verifyUrl || 'https://verify-sepolia.eigencloud.xyz/'} target="_blank">Verify Dashboard</a>
            <Badge className="justify-center">{status}</Badge>
          </div>
          <div className="grid gap-2 md:grid-cols-4">
            <input
              className="rounded border border-border bg-black/30 p-2 md:col-span-3"
              placeholder="API key (agent key from register, or optional owner key)"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value.trim())}
            />
            <Button variant="outline" disabled={busy} onClick={() => runAction('Refresh', refreshAll)}>
              <Wifi className="mr-2" size={14} /> Refresh
            </Button>
          </div>
          {auth && (
            <div className="flex flex-wrap gap-2 text-xs">
              <Badge>Role: {auth.role}</Badge>
              <Badge>Public read: {auth.config.allowPublicRead ? 'on' : 'off'}</Badge>
              <Badge>Agent API keys: {auth.config.acceptsAgentApiKeys ? 'enabled' : 'disabled'}</Badge>
              <Badge>Owner keys configured: {(auth.config.hasAdminKey || auth.config.hasOperatorKey || auth.config.hasReadonlyKey) ? 'yes' : 'no'}</Badge>
            </div>
          )}
        </Card>
      </motion.section>

      <div className="grid gap-6 xl:grid-cols-3">
        <Card>
          <div className="mb-3 flex items-center gap-2 font-semibold">Install Agent Skill</div>
          <p className="mb-3 text-xs text-slate-300">
            MoltCourt-style onboarding: no invite token needed. Share skill URL and register directly.
          </p>

          <div className="space-y-2 text-xs">
            <div>
              <div className="text-slate-300">Skill URL</div>
              <div className="font-mono break-all">{apiBase}/skill.md</div>
            </div>
            <div>
              <div className="text-slate-300">Register endpoint</div>
              <div className="font-mono break-all">{apiBase}/api/agents/register</div>
            </div>
            <div className="rounded border border-border bg-black/20 p-2 font-mono break-all">
              curl -s {apiBase}/skill.md
            </div>
          </div>
        </Card>

        <Card className="xl:col-span-2">
          <div className="mb-3 flex items-center gap-2 font-semibold">Challenge Arena (Install → Challenge → Combat → Verdict)</div>

          <div className="grid gap-2 md:grid-cols-2">
            <input
              className="rounded border border-border bg-black/30 p-2 md:col-span-2"
              placeholder="Challenge topic (example: Starknet vs EVM tactics under resource pressure)"
              value={challengeForm.topic}
              onChange={(e) => setChallengeForm({ ...challengeForm, topic: e.target.value })}
            />
            <select className="rounded border border-border bg-black/30 p-2" value={challengeForm.challengerAgentId} onChange={(e) => setChallengeForm({ ...challengeForm, challengerAgentId: e.target.value })}>
              <option value="">Challenger agent</option>
              {enabledAgents.map((agent) => <option key={agent.id} value={agent.id}>{agent.id} — {agent.name}</option>)}
            </select>
            <select className="rounded border border-border bg-black/30 p-2" value={challengeForm.opponentAgentId} onChange={(e) => setChallengeForm({ ...challengeForm, opponentAgentId: e.target.value })}>
              <option value="">Opponent agent (leave empty for open challenge)</option>
              {enabledAgents.map((agent) => <option key={agent.id} value={agent.id}>{agent.id} — {agent.name}</option>)}
            </select>
            <select className="rounded border border-border bg-black/30 p-2" value={challengeForm.stakeMode} onChange={(e) => setChallengeForm({ ...challengeForm, stakeMode: e.target.value as 'none' | 'usdc' })}>
              <option value="none">No stake</option>
              <option value="usdc">USDC escrow stake</option>
            </select>
          </div>

          {challengeForm.stakeMode === 'usdc' && (
            <div className="mt-2 grid gap-2 md:grid-cols-2">
              <input className="rounded border border-border bg-black/30 p-2" placeholder="USDC escrow contract" value={challengeForm.contractAddress} onChange={(e) => setChallengeForm({ ...challengeForm, contractAddress: e.target.value })} />
              <input className="rounded border border-border bg-black/30 p-2" placeholder="Amount per player (6dp)" value={challengeForm.amountPerPlayer} onChange={(e) => setChallengeForm({ ...challengeForm, amountPerPlayer: e.target.value })} />
              <input className="rounded border border-border bg-black/30 p-2" placeholder="Player A wallet" value={challengeForm.playerA} onChange={(e) => setChallengeForm({ ...challengeForm, playerA: e.target.value })} />
              <input className="rounded border border-border bg-black/30 p-2" placeholder="Player B wallet" value={challengeForm.playerB} onChange={(e) => setChallengeForm({ ...challengeForm, playerB: e.target.value })} />
            </div>
          )}

          <div className="mt-2">
            <Button disabled={busy} onClick={() => runAction('Create challenge', async () => {
              await request('/challenges', apiKey, {
                method: 'POST',
                body: JSON.stringify({
                  topic: challengeForm.topic || 'Untitled combat challenge',
                  challengerAgentId: challengeForm.challengerAgentId,
                  opponentAgentId: challengeForm.opponentAgentId || undefined,
                  stake: challengeForm.stakeMode === 'usdc'
                    ? {
                        mode: 'usdc',
                        contractAddress: challengeForm.contractAddress,
                        amountPerPlayer: challengeForm.amountPerPlayer,
                        playerA: challengeForm.playerA,
                        playerB: challengeForm.playerB
                      }
                    : { mode: 'none' }
                })
              });
            })}>Create Challenge</Button>
          </div>

          <div className="mt-3 max-h-60 overflow-auto text-xs">
            <table className="w-full">
              <thead>
                <tr className="border-b border-border text-left text-slate-300">
                  <th className="p-2">Challenge</th>
                  <th className="p-2">Status</th>
                  <th className="p-2">Agents</th>
                  <th className="p-2">Actions</th>
                </tr>
              </thead>
              <tbody>
                {challenges.slice(0, 20).map((challenge) => (
                  <tr key={challenge.id} className="border-b border-border/50">
                    <td className="p-2">
                      <div className="font-mono">{challenge.id}</div>
                      <div>{challenge.topic}</div>
                      {challenge.matchId && <div className="text-slate-300">match: {challenge.matchId}</div>}
                    </td>
                    <td className="p-2">{challenge.status}</td>
                    <td className="p-2">
                      {challenge.challengerAgentId} vs {challenge.opponentAgentId || 'OPEN'}
                      {challenge.winnerAgentId && <div className="text-slate-300">winner: {challenge.winnerAgentId}</div>}
                    </td>
                    <td className="p-2">
                      <div className="flex flex-wrap gap-1">
                        {challenge.status === 'open' && (
                          <>
                            <select
                              className="rounded border border-border bg-black/30 p-1"
                              value={challengeAcceptById[challenge.id] || ''}
                              onChange={(e) => setChallengeAcceptById((prev) => ({ ...prev, [challenge.id]: e.target.value }))}
                            >
                              <option value="">Pick opponent</option>
                              {enabledAgents.map((agent) => <option key={agent.id} value={agent.id}>{agent.id}</option>)}
                            </select>
                            <Button variant="outline" disabled={busy} onClick={() => runAction('Accept challenge', async () => {
                              const opponent = challengeAcceptById[challenge.id] || challengeForm.opponentAgentId;
                              await request(`/challenges/${challenge.id}/accept`, apiKey, {
                                method: 'POST',
                                body: JSON.stringify({ opponentAgentId: opponent })
                              });
                            })}>Accept</Button>
                          </>
                        )}
                        {(challenge.status === 'accepted' || challenge.status === 'open') && (
                          <Button disabled={busy} onClick={() => runAction('Start challenge', async () => {
                            const started = await request<{ ok: boolean; match?: { id: string } }>(`/challenges/${challenge.id}/start`, apiKey, {
                              method: 'POST',
                              body: JSON.stringify(challenge.status === 'open'
                                ? { opponentAgentId: challengeAcceptById[challenge.id] || challengeForm.opponentAgentId || undefined }
                                : {})
                            });
                            if (started.match?.id) setSelectedMatchId(started.match.id);
                          })}>Start</Button>
                        )}

                        {(challenge.status === 'awaiting_judgement' || (challenge.status === 'completed' && !challenge.winnerAgentId)) && (
                          <>
                            <select
                              className="rounded border border-border bg-black/30 p-1"
                              value={challengeJudgeById[challenge.id] || challenge.challengerAgentId}
                              onChange={(e) => setChallengeJudgeById((prev) => ({ ...prev, [challenge.id]: e.target.value }))}
                            >
                              <option value={challenge.challengerAgentId}>{challenge.challengerAgentId}</option>
                              {challenge.opponentAgentId && <option value={challenge.opponentAgentId}>{challenge.opponentAgentId}</option>}
                            </select>
                            <Button variant="outline" disabled={busy} onClick={() => runAction('Adjudicate challenge', async () => {
                              await request(`/challenges/${challenge.id}/adjudicate`, apiKey, {
                                method: 'POST',
                                body: JSON.stringify({
                                  winnerAgentId: challengeJudgeById[challenge.id] || challenge.challengerAgentId,
                                  settleEscrow: true,
                                  note: 'manual adjudication from dashboard'
                                })
                              });
                            })}>Adjudicate + Settle</Button>
                          </>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      </div>

      <div className="grid gap-6 xl:grid-cols-3">
        <Card className="xl:col-span-2">
          <div className="mb-3 flex items-center gap-2 font-semibold">
            <PlayCircle size={18} /> Create Match
          </div>

          <div className="mb-3 grid gap-2 md:grid-cols-2">
            <select className="rounded border border-border bg-black/30 p-2" value={form.fromRegistryA} onChange={(e) => {
              const selected = enabledAgents.find((a) => a.id === e.target.value);
              if (selected) setAgentToSlot('A', selected);
              else setForm((prev) => ({ ...prev, fromRegistryA: '' }));
            }}>
              <option value="">Agent A from registry (optional)</option>
              {enabledAgents.map((agent) => (
                <option key={agent.id} value={agent.id}>{agent.id} — {agent.name}</option>
              ))}
            </select>

            <select className="rounded border border-border bg-black/30 p-2" value={form.fromRegistryB} onChange={(e) => {
              const selected = enabledAgents.find((a) => a.id === e.target.value);
              if (selected) setAgentToSlot('B', selected);
              else setForm((prev) => ({ ...prev, fromRegistryB: '' }));
            }}>
              <option value="">Agent B from registry (optional)</option>
              {enabledAgents.map((agent) => (
                <option key={agent.id} value={agent.id}>{agent.id} — {agent.name}</option>
              ))}
            </select>
          </div>

          <div className="grid gap-3 md:grid-cols-2">
            <input className="rounded border border-border bg-black/30 p-2" placeholder="Agent A id" value={form.aId} onChange={(e) => setForm({ ...form, aId: e.target.value })} />
            <input className="rounded border border-border bg-black/30 p-2" placeholder="Agent B id" value={form.bId} onChange={(e) => setForm({ ...form, bId: e.target.value })} />
            <input className="rounded border border-border bg-black/30 p-2" placeholder="Agent A name" value={form.aName} onChange={(e) => setForm({ ...form, aName: e.target.value })} />
            <input className="rounded border border-border bg-black/30 p-2" placeholder="Agent B name" value={form.bName} onChange={(e) => setForm({ ...form, bName: e.target.value })} />
            <input className="rounded border border-border bg-black/30 p-2" placeholder="Agent A endpoint" value={form.aEndpoint} onChange={(e) => setForm({ ...form, aEndpoint: e.target.value })} />
            <input className="rounded border border-border bg-black/30 p-2" placeholder="Agent B endpoint" value={form.bEndpoint} onChange={(e) => setForm({ ...form, bEndpoint: e.target.value })} />
            <input className="rounded border border-border bg-black/30 p-2" placeholder="Agent A payout address" value={form.aPayout} onChange={(e) => setForm({ ...form, aPayout: e.target.value })} />
            <input className="rounded border border-border bg-black/30 p-2" placeholder="Agent B payout address" value={form.bPayout} onChange={(e) => setForm({ ...form, bPayout: e.target.value })} />
            <input className="rounded border border-border bg-black/30 p-2" placeholder="maxTurns" value={form.maxTurns} onChange={(e) => setForm({ ...form, maxTurns: e.target.value })} />
            <input className="rounded border border-border bg-black/30 p-2" placeholder="attackCost" value={form.attackCost} onChange={(e) => setForm({ ...form, attackCost: e.target.value })} />
            <input className="rounded border border-border bg-black/30 p-2" placeholder="attackDamage" value={form.attackDamage} onChange={(e) => setForm({ ...form, attackDamage: e.target.value })} />
          </div>

          <div className="mt-3">
            <Button
              disabled={busy}
              onClick={() => runAction('Create match', async () => {
                const useRegistry = Boolean(form.fromRegistryA && form.fromRegistryB);

                const payload = {
                  ...(useRegistry
                    ? { agentIds: [form.fromRegistryA, form.fromRegistryB] }
                    : {
                        agents: [
                          { id: form.aId, name: form.aName, endpoint: form.aEndpoint, payoutAddress: form.aPayout || undefined },
                          { id: form.bId, name: form.bName, endpoint: form.bEndpoint, payoutAddress: form.bPayout || undefined }
                        ]
                      }),
                  config: {
                    maxTurns: Number(form.maxTurns),
                    seed: 1,
                    attackCost: Number(form.attackCost),
                    attackDamage: Number(form.attackDamage)
                  },
                  payout: { enabled: false }
                };

                const res = await request<MatchDetail>('/matches', apiKey, {
                  method: 'POST',
                  body: JSON.stringify(payload)
                });

                setSelectedMatchId(res.id);
              })}
            >
              Run Match
            </Button>
          </div>
        </Card>

        <Card>
          <div className="mb-4 flex items-center gap-2 font-semibold">
            <ShieldCheck size={18} /> Verification
          </div>
          {verification ? (
            <ul className="space-y-2 text-sm">
              <li className="flex justify-between"><span>Environment</span><Badge>{verification.environment}</Badge></li>
              <li className="flex justify-between"><span>App IDs</span><Badge>{verification.appIds?.length || 0}</Badge></li>
              <li className="flex justify-between"><span>Chain</span><Badge>{verification.checks.chainConfigLoaded ? 'Loaded' : 'Missing'}</Badge></li>
              <li className="flex justify-between"><span>Signer</span><Badge>{verification.checks.signerLoaded ? 'Loaded' : 'Missing'}</Badge></li>
              <li className="flex justify-between"><span>PrizePool</span><span className="font-mono text-xs">{verification.contracts?.prizePool || '-'}</span></li>
              <li className="flex justify-between"><span>USDC Escrow</span><span className="font-mono text-xs">{verification.contracts?.usdcEscrow || '-'}</span></li>
            </ul>
          ) : <p className="text-sm text-slate-300">Verification endpoint unavailable.</p>}
        </Card>
      </div>

      <div className="grid gap-6 xl:grid-cols-3">
        <Card className="xl:col-span-2">
          <div className="mb-3 flex items-center gap-2 font-semibold">
            <WalletCards size={18} /> Match Operations
          </div>

          <div className="mb-3 flex items-center gap-2">
            <select className="rounded border border-border bg-black/30 p-2" value={selectedMatchId} onChange={(e) => setSelectedMatchId(e.target.value)}>
              <option value="">Select match</option>
              {matches.map((match) => (
                <option key={match.id} value={match.id}>{match.id}</option>
              ))}
            </select>
            <Button variant="outline" disabled={busy} onClick={() => runAction('Refresh', refreshAll)}>Refresh</Button>
          </div>

          {selectedMatch?.matchIdHex && (
            <div className="mb-3 rounded border border-border bg-black/20 p-2 text-xs">
              <span className="text-slate-300">Onchain Match ID (bytes32):</span>{' '}
              <span className="font-mono break-all">{selectedMatch.matchIdHex}</span>
            </div>
          )}

          <div className="grid gap-3 md:grid-cols-2">
            <input className="rounded border border-border bg-black/30 p-2" placeholder="PrizePool contract" value={ops.prizeContract} onChange={(e) => setOps({ ...ops, prizeContract: e.target.value })} />
            <input className="rounded border border-border bg-black/30 p-2" placeholder="Fund amount ETH" value={ops.fundAmountEth} onChange={(e) => setOps({ ...ops, fundAmountEth: e.target.value })} />
            <input className="rounded border border-border bg-black/30 p-2" placeholder="Payout winner address" value={ops.payoutWinner} onChange={(e) => setOps({ ...ops, payoutWinner: e.target.value })} />
            <div className="flex gap-2">
              <Button disabled={busy || !selectedMatchId} onClick={() => runAction('Fund prize', async () => {
                await request(`/matches/${selectedMatchId}/fund`, apiKey, {
                  method: 'POST',
                  body: JSON.stringify({ contractAddress: ops.prizeContract, amountEth: ops.fundAmountEth })
                });
              })}><Coins className="mr-2" size={14} /> Fund ETH</Button>
              <Button disabled={busy || !selectedMatchId} onClick={() => runAction('Payout winner', async () => {
                await request(`/matches/${selectedMatchId}/payout`, apiKey, {
                  method: 'POST',
                  body: JSON.stringify({ contractAddress: ops.prizeContract, winner: ops.payoutWinner })
                });
              })}>Payout</Button>
            </div>
          </div>

          <div className="mt-4 grid gap-3 md:grid-cols-2">
            <input className="rounded border border-border bg-black/30 p-2" placeholder="USDC Escrow contract" value={ops.escrowContract} onChange={(e) => setOps({ ...ops, escrowContract: e.target.value })} />
            <input className="rounded border border-border bg-black/30 p-2" placeholder="Amount per player (6dp)" value={ops.escrowAmountPerPlayer} onChange={(e) => setOps({ ...ops, escrowAmountPerPlayer: e.target.value })} />
            <input className="rounded border border-border bg-black/30 p-2" placeholder="Escrow Player A" value={ops.escrowPlayerA} onChange={(e) => setOps({ ...ops, escrowPlayerA: e.target.value })} />
            <input className="rounded border border-border bg-black/30 p-2" placeholder="Escrow Player B" value={ops.escrowPlayerB} onChange={(e) => setOps({ ...ops, escrowPlayerB: e.target.value })} />
            <input className="rounded border border-border bg-black/30 p-2" placeholder="Escrow winner" value={ops.escrowWinner} onChange={(e) => setOps({ ...ops, escrowWinner: e.target.value })} />
            <div className="flex gap-2">
              <Button variant="outline" disabled={busy || !selectedMatchId} onClick={() => runAction('Create escrow', async () => {
                await request(`/matches/${selectedMatchId}/escrow/create`, apiKey, {
                  method: 'POST',
                  body: JSON.stringify({
                    contractAddress: ops.escrowContract,
                    playerA: ops.escrowPlayerA,
                    playerB: ops.escrowPlayerB,
                    amountPerPlayer: ops.escrowAmountPerPlayer
                  })
                });
              })}>Create Escrow</Button>
              <Button disabled={busy || !selectedMatchId} onClick={() => runAction('Settle escrow', async () => {
                await request(`/matches/${selectedMatchId}/escrow/settle`, apiKey, {
                  method: 'POST',
                  body: JSON.stringify({ contractAddress: ops.escrowContract, winner: ops.escrowWinner })
                });
              })}>Settle Escrow</Button>
              <Button variant="outline" disabled={busy || !selectedMatchId || !ops.escrowContract} onClick={() => runAction('Escrow status', async () => {
                const status = await request<EscrowStatus>(`/matches/${selectedMatchId}/escrow/status?contractAddress=${encodeURIComponent(ops.escrowContract)}`, apiKey);
                setEscrowStatus(status);
              })}>Escrow Status</Button>
            </div>
          </div>

          {escrowStatus && (
            <div className="mt-3 rounded border border-border bg-black/20 p-3 text-xs">
              <div className="mb-1 font-semibold">Escrow Onchain Status</div>
              <div className="font-mono break-all">matchIdHex: {escrowStatus.matchIdHex}</div>
              <div>playerA: {escrowStatus.playerA}</div>
              <div>playerB: {escrowStatus.playerB}</div>
              <div>amountPerPlayer: {escrowStatus.amountPerPlayer}</div>
              <div>playerADeposited: {String(escrowStatus.playerADeposited)}</div>
              <div>playerBDeposited: {String(escrowStatus.playerBDeposited)}</div>
              <div>settled: {String(escrowStatus.settled)}</div>
            </div>
          )}
        </Card>

        <Card>
          <div className="mb-4 flex items-center gap-2 font-semibold">
            <Trophy size={18} /> Leaderboard
          </div>
          <div className="h-56">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={leaderboard}>
                <XAxis dataKey="agent" stroke="#9db0ff" />
                <YAxis stroke="#9db0ff" allowDecimals={false} />
                <Tooltip />
                <Bar dataKey="wins" fill="#5b7cfa" radius={[6, 6, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </Card>
      </div>

      <div className="grid gap-6 xl:grid-cols-3">
        <Card className="xl:col-span-2">
          <div className="mb-3 flex items-center gap-2 font-semibold">
            <Activity size={18} /> Agent Registry
          </div>

          <div className="grid gap-3 md:grid-cols-2">
            <input className="rounded border border-border bg-black/30 p-2" placeholder="Agent id" value={agentForm.id} onChange={(e) => setAgentForm({ ...agentForm, id: e.target.value })} />
            <input className="rounded border border-border bg-black/30 p-2" placeholder="Agent name" value={agentForm.name} onChange={(e) => setAgentForm({ ...agentForm, name: e.target.value })} />
            <input className="rounded border border-border bg-black/30 p-2" placeholder="Endpoint URL" value={agentForm.endpoint} onChange={(e) => setAgentForm({ ...agentForm, endpoint: e.target.value })} />
            <input className="rounded border border-border bg-black/30 p-2" placeholder="Payout address (optional)" value={agentForm.payoutAddress} onChange={(e) => setAgentForm({ ...agentForm, payoutAddress: e.target.value })} />
            <input className="rounded border border-border bg-black/30 p-2 md:col-span-2" placeholder="Agent API key (optional)" value={agentForm.apiKey} onChange={(e) => setAgentForm({ ...agentForm, apiKey: e.target.value })} />
          </div>

          <div className="mt-3">
            <Button disabled={busy} onClick={() => runAction('Register agent', async () => {
              await request('/agents', apiKey, {
                method: 'POST',
                body: JSON.stringify({
                  id: agentForm.id,
                  name: agentForm.name,
                  endpoint: agentForm.endpoint,
                  payoutAddress: agentForm.payoutAddress || undefined,
                  apiKey: agentForm.apiKey || undefined,
                  enabled: true
                })
              });
              setAgentForm({ id: '', name: '', endpoint: '', payoutAddress: '', apiKey: '' });
            })}>Register / Update Agent</Button>
          </div>

          <div className="mt-4 overflow-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-border text-left text-slate-300">
                  <th className="p-2">ID</th>
                  <th className="p-2">Name</th>
                  <th className="p-2">Health</th>
                  <th className="p-2">Enabled</th>
                  <th className="p-2">Actions</th>
                </tr>
              </thead>
              <tbody>
                {agents.map((agent) => (
                  <tr key={agent.id} className="border-b border-border/50">
                    <td className="p-2 font-mono">{agent.id}</td>
                    <td className="p-2">{agent.name}</td>
                    <td className="p-2">{agent.lastHealthStatus}</td>
                    <td className="p-2">{agent.enabled ? 'yes' : 'no'}</td>
                    <td className="p-2">
                      <div className="flex flex-wrap gap-1">
                        <Button variant="outline" disabled={busy} onClick={() => runAction(`Health ${agent.id}`, async () => {
                          await request(`/agents/${agent.id}/health`, apiKey, { method: 'POST' });
                        })}>Health</Button>
                        <Button variant="outline" disabled={busy} onClick={() => setAgentToSlot('A', agent)}>Use A</Button>
                        <Button variant="outline" disabled={busy} onClick={() => setAgentToSlot('B', agent)}>Use B</Button>
                        <Button disabled={busy} onClick={() => runAction(`Disable ${agent.id}`, async () => {
                          await request(`/agents/${agent.id}`, apiKey, { method: 'DELETE' });
                        })}>Disable</Button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>

        <Card>
          <div className="mb-4 flex items-center gap-2 font-semibold"><Activity size={18} /> API Telemetry</div>
          <div className="space-y-2 text-sm">
            <a className="block rounded border border-border px-3 py-2 text-center" href={`${apiBase}/metrics`} target="_blank">Open /metrics</a>
            <a className="block rounded border border-border px-3 py-2 text-center" href={`${apiBase}/health`} target="_blank">Open /health</a>
            <p className="text-slate-300 text-xs">
              Use these endpoints for uptime and monitoring hooks. Alerts can poll `/health` and `/metrics`.
            </p>
          </div>
        </Card>
      </div>

      <Card>
        <div className="mb-3 font-semibold">Recent Matches</div>
        <div className="overflow-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-left text-slate-300">
                <th className="p-2">Match</th>
                <th className="p-2">Status</th>
                <th className="p-2">Turns</th>
                <th className="p-2">Winner</th>
              </tr>
            </thead>
            <tbody>
              {matches.slice(0, 20).map((match) => (
                <tr key={match.id} className="cursor-pointer border-b border-border/50 hover:bg-white/5" onClick={() => setSelectedMatchId(match.id)}>
                  <td className="p-2 font-mono text-xs">{match.id}</td>
                  <td className="p-2">{match.status}</td>
                  <td className="p-2">{match.turnsPlayed}</td>
                  <td className="p-2">{match.winner ?? '-'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      {detail && (
        <Card>
          <div className="mb-3 font-semibold">Replay Snapshot — {detail.id}</div>
          <div className="max-h-72 overflow-auto text-xs">
            <table className="w-full">
              <thead>
                <tr className="border-b border-border text-left text-slate-300">
                  <th className="p-2">Turn</th>
                  <th className="p-2">State</th>
                </tr>
              </thead>
              <tbody>
                {detail.replay.slice(0, 30).map((turn) => (
                  <tr key={turn.turn} className="border-b border-border/50">
                    <td className="p-2">{turn.turn}</td>
                    <td className="p-2">{turn.states.map((state) => `${state.agentId}(hp:${state.hp},score:${state.score})`).join(' | ')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </main>
  );
}
