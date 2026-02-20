import 'server-only';

import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

export type ProxyMode = 'json' | 'text';

function normalizeHttpUrl(value: string | undefined): string | null {
  const raw = value?.trim();
  if (!raw) return null;

  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    parsed.hash = '';
    parsed.search = '';
    return parsed.toString().replace(/\/$/, '');
  } catch {
    return null;
  }
}

function requestOrigin(req: NextRequest): string {
  const forwardedProto = req.headers.get('x-forwarded-proto')?.split(',')[0]?.trim();
  const forwardedHost = req.headers.get('x-forwarded-host')?.split(',')[0]?.trim();

  const proto = forwardedProto || req.nextUrl.protocol.replace(/:$/, '') || 'http';
  const host = forwardedHost || req.headers.get('host') || req.nextUrl.host || 'localhost';

  return `${proto}://${host}`.replace(/\/$/, '');
}

function sameOrigin(a: string, b: string): boolean {
  try {
    const ua = new URL(a);
    const ub = new URL(b);
    return ua.protocol === ub.protocol && ua.host === ub.host;
  } catch {
    return false;
  }
}

/**
 * Resolve backend API base URL for server-side proxying.
 *
 * Priority:
 * 1) BACKEND_API_URL (recommended)
 * 2) API_BASE_URL
 * 3) NEXT_PUBLIC_API_URL (legacy fallback)
 *
 * Safety: if candidate points to the current frontend origin, reject it to avoid
 * self-proxy loops (frontend calling itself instead of the API host).
 */
export function resolveBackendBaseUrl(req: NextRequest): string | null {
  const frontendOrigin = requestOrigin(req);

  const candidates = [
    process.env.BACKEND_API_URL,
    process.env.API_BASE_URL,
    process.env.NEXT_PUBLIC_API_URL
  ];

  for (const candidate of candidates) {
    const normalized = normalizeHttpUrl(candidate);
    if (!normalized) continue;
    if (sameOrigin(normalized, frontendOrigin)) continue;
    return normalized;
  }

  return null;
}

function readonlyKey(): string {
  return (
    process.env.READONLY_API_KEY?.trim() ||
    process.env.NEXT_PUBLIC_READONLY_API_KEY?.trim() ||
    ''
  );
}

function targetUrl(req: NextRequest, backendBaseUrl: string, backendPath: string) {
  const target = new URL(backendBaseUrl);
  const normalizedBackendPath = backendPath.startsWith('/') ? backendPath : `/${backendPath}`;

  const basePath = target.pathname === '/' ? '' : target.pathname.replace(/\/$/, '');
  target.pathname = `${basePath}${normalizedBackendPath}`;
  target.search = req.nextUrl.search;

  return target;
}

function resolveBackendPath(apiPath: string[]): string {
  const normalized = apiPath.filter(Boolean).join('/');

  if (!normalized) return '/';

  // Preserve legacy backend register endpoint.
  if (normalized === 'agents/register' || normalized === 'api/agents/register') {
    return '/api/agents/register';
  }

  return `/${normalized}`;
}

function outboundHeaders(req: NextRequest): Headers {
  const headers = new Headers();

  const contentType = req.headers.get('content-type');
  if (contentType) headers.set('content-type', contentType);

  const accept = req.headers.get('accept');
  if (accept) headers.set('accept', accept);

  const inboundAuthorization = req.headers.get('authorization');
  if (inboundAuthorization) headers.set('authorization', inboundAuthorization);

  const inboundApiKey = req.headers.get('x-api-key');
  if (inboundApiKey) headers.set('x-api-key', inboundApiKey);

  const inboundCookie = req.headers.get('cookie');
  if (inboundCookie) headers.set('cookie', inboundCookie);

  if (!inboundAuthorization && !inboundApiKey) {
    const fallback = readonlyKey();
    if (fallback) headers.set('authorization', `Bearer ${fallback}`);
  }

  return headers;
}

function contentTypeFor(mode: ProxyMode, upstreamContentType: string | null) {
  if (upstreamContentType) return upstreamContentType;
  return mode === 'text'
    ? 'text/markdown; charset=utf-8'
    : 'application/json; charset=utf-8';
}

function backendConfigError(mode: ProxyMode) {
  const message =
    'backend_api_url_not_configured: set BACKEND_API_URL to your API host URL (must not be the frontend domain)';

  if (mode === 'text') {
    return new NextResponse(message, {
      status: 500,
      headers: {
        'content-type': 'text/plain; charset=utf-8',
        'cache-control': 'no-store'
      }
    });
  }

  return NextResponse.json(
    {
      ok: false,
      error: 'backend_api_url_not_configured',
      message
    },
    {
      status: 500,
      headers: {
        'cache-control': 'no-store'
      }
    }
  );
}

function proxyError(mode: ProxyMode, error: unknown) {
  const message = error instanceof Error ? error.message : 'frontend_proxy_error';

  if (mode === 'text') {
    return new NextResponse(message, {
      status: 502,
      headers: {
        'content-type': 'text/plain; charset=utf-8',
        'cache-control': 'no-store'
      }
    });
  }

  return NextResponse.json(
    {
      ok: false,
      error: 'frontend_proxy_error',
      message
    },
    {
      status: 502,
      headers: {
        'cache-control': 'no-store'
      }
    }
  );
}

export async function proxyRequest(req: NextRequest, backendPath: string, mode: ProxyMode = 'json') {
  try {
    const backendBaseUrl = resolveBackendBaseUrl(req);
    if (!backendBaseUrl) return backendConfigError(mode);

    const method = req.method.toUpperCase();
    const hasBody = !['GET', 'HEAD'].includes(method);

    const upstream = await fetch(targetUrl(req, backendBaseUrl, backendPath), {
      method,
      headers: outboundHeaders(req),
      body: hasBody ? await req.arrayBuffer() : undefined,
      cache: 'no-store'
    });

    const body = method === 'HEAD' ? '' : await upstream.text();

    const headers = new Headers(upstream.headers);
    headers.delete('content-length');
    headers.delete('content-encoding');

    if (!headers.get('content-type')) {
      headers.set('content-type', contentTypeFor(mode, upstream.headers.get('content-type')));
    }
    headers.set('cache-control', 'no-store');

    return new NextResponse(body, {
      status: upstream.status,
      headers
    });
  } catch (error) {
    return proxyError(mode, error);
  }
}

export async function proxyGet(req: NextRequest, backendPath: string, mode: ProxyMode = 'json') {
  return proxyRequest(req, backendPath, mode);
}

export async function proxyApiPath(req: NextRequest, apiPath: string[], mode: ProxyMode = 'json') {
  const backendPath = resolveBackendPath(apiPath);
  return proxyRequest(req, backendPath, mode);
}
