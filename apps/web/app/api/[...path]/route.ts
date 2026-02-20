import type { NextRequest } from 'next/server';
import { proxyApiPath } from '../_lib/proxy';

export const dynamic = 'force-dynamic';

type RouteContext = { params: Promise<{ path: string[] }> };

async function segments(context: RouteContext): Promise<string[]> {
  const params = await context.params;
  return Array.isArray(params.path) ? params.path : [];
}

export async function GET(req: NextRequest, context: RouteContext) {
  return proxyApiPath(req, await segments(context));
}

export async function POST(req: NextRequest, context: RouteContext) {
  return proxyApiPath(req, await segments(context));
}

export async function PUT(req: NextRequest, context: RouteContext) {
  return proxyApiPath(req, await segments(context));
}

export async function PATCH(req: NextRequest, context: RouteContext) {
  return proxyApiPath(req, await segments(context));
}

export async function DELETE(req: NextRequest, context: RouteContext) {
  return proxyApiPath(req, await segments(context));
}

export async function OPTIONS(req: NextRequest, context: RouteContext) {
  return proxyApiPath(req, await segments(context));
}

export async function HEAD(req: NextRequest, context: RouteContext) {
  return proxyApiPath(req, await segments(context));
}
