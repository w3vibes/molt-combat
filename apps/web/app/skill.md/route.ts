import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { proxyRequest, resolveBackendBaseUrl } from '../api/_lib/proxy';

export const dynamic = 'force-dynamic';

function frontendOrigin(req: NextRequest): string {
  const forwardedProto = req.headers.get('x-forwarded-proto')?.split(',')[0]?.trim();
  const forwardedHost = req.headers.get('x-forwarded-host')?.split(',')[0]?.trim();

  const proto = forwardedProto || req.nextUrl.protocol.replace(/:$/, '') || 'http';
  const host = forwardedHost || req.headers.get('host') || req.nextUrl.host || 'localhost:3001';

  return `${proto}://${host}`.replace(/\/$/, '');
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function rewriteSkillMarkdown(markdown: string, fromBase: string, toBase: string): string {
  if (!fromBase || !toBase || fromBase === toBase) return markdown;
  const pattern = new RegExp(escapeRegExp(fromBase), 'g');
  return markdown.replace(pattern, toBase);
}

async function serveSkill(req: NextRequest, method: 'GET' | 'HEAD') {
  const proxied = await proxyRequest(req, '/skill.md', 'text');
  if (!proxied.ok) return proxied;

  const original = method === 'HEAD' ? '' : await proxied.text();
  const backendBase = resolveBackendBaseUrl(req);
  const rewritten = method === 'HEAD'
    ? ''
    : rewriteSkillMarkdown(original, backendBase || '', frontendOrigin(req));

  const headers = new Headers(proxied.headers);
  headers.delete('content-length');
  headers.delete('content-encoding');
  headers.set('content-type', headers.get('content-type') || 'text/markdown; charset=utf-8');
  headers.set('cache-control', 'no-store');

  return new NextResponse(rewritten, {
    status: proxied.status,
    headers
  });
}

export async function GET(req: NextRequest) {
  return serveSkill(req, 'GET');
}

export async function HEAD(req: NextRequest) {
  return serveSkill(req, 'HEAD');
}
