type RouteMetric = {
  count: number;
  totalMs: number;
  errors: number;
};

type RequestSnapshot = {
  timestamp: string;
  route: string;
  method: string;
  statusCode: number;
  durationMs: number;
};

const routeStats = new Map<string, RouteMetric>();
const recentRequests: RequestSnapshot[] = [];

let totalRequests = 0;
let totalErrors = 0;

function bucketKey(method: string, route: string) {
  return `${method.toUpperCase()} ${route}`;
}

function trimRecent() {
  const max = Number(process.env.METRICS_RECENT_LIMIT || 100);
  while (recentRequests.length > max) recentRequests.shift();
}

export const metrics = {
  observe(params: { route: string; method: string; statusCode: number; durationMs: number }) {
    totalRequests += 1;
    const isError = params.statusCode >= 400;
    if (isError) totalErrors += 1;

    const key = bucketKey(params.method, params.route);
    const prev = routeStats.get(key) || { count: 0, totalMs: 0, errors: 0 };
    prev.count += 1;
    prev.totalMs += params.durationMs;
    if (isError) prev.errors += 1;
    routeStats.set(key, prev);

    recentRequests.push({
      timestamp: new Date().toISOString(),
      route: params.route,
      method: params.method,
      statusCode: params.statusCode,
      durationMs: params.durationMs
    });
    trimRecent();
  },

  snapshot() {
    const routes = [...routeStats.entries()].map(([route, value]) => ({
      route,
      count: value.count,
      errors: value.errors,
      avgMs: value.count ? Number((value.totalMs / value.count).toFixed(2)) : 0
    })).sort((a, b) => b.count - a.count);

    return {
      totalRequests,
      totalErrors,
      errorRate: totalRequests ? Number(((totalErrors / totalRequests) * 100).toFixed(2)) : 0,
      routes,
      recentRequests
    };
  }
};
