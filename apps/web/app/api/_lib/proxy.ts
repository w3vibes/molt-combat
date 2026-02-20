import 'server-only';

import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

export type ProxyMode = 'json' | 'text';

function backendBaseUrl(): string {
  return (
    process.env.BACKEND_API_URL?.trim() ||
    process.env.NEXT_PUBLIC_API_URL?.trim() ||
    'http://localhost:3000'
  ).replace(/\/$/, '');
}

function readonlyKey(): string {
  return (
    process.env.READONLY_API_KEY?.trim() ||
    process.env.NEXT_PUBLIC_READONLY_API_KEY?.trim() ||
    ''
  );
}

function targetUrl(req: NextRequest, backendPath: string) {
  const target = new URL(`${backendBaseUrl()}${backendPath}`);
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

  const inboundAuth = req.headers.get('authorization');
  if (inboundAuth) {
    headers.set('authorization', inboundAuth);
  } else {
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
    const method = req.method.toUpperCase();
    const hasBody = !['GET', 'HEAD'].includes(method);

    const upstream = await fetch(targetUrl(req, backendPath), {
      method,
      headers: outboundHeaders(req),
      body: hasBody ? await req.arrayBuffer() : undefined,
      cache: 'no-store'
    });

    const body = method === 'HEAD' ? '' : await upstream.text();

    return new NextResponse(body, {
      status: upstream.status,
      headers: {
        'content-type': contentTypeFor(mode, upstream.headers.get('content-type')),
        'cache-control': 'no-store'
      }
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
