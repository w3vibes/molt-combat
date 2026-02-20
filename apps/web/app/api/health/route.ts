import type { NextRequest } from 'next/server';
import { proxyGet } from '../_lib/proxy';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  return proxyGet(req, '/health');
}
