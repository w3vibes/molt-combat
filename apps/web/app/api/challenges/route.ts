import type { NextRequest } from 'next/server';
import { proxyRequest } from '../_lib/proxy';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  return proxyRequest(req, '/challenges');
}

export async function POST(req: NextRequest) {
  return proxyRequest(req, '/challenges');
}

export async function OPTIONS(req: NextRequest) {
  return proxyRequest(req, '/challenges');
}

export async function HEAD(req: NextRequest) {
  return proxyRequest(req, '/challenges');
}
