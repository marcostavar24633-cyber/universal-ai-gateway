// Daily per-project request quota. One Durable Object instance per project
// keeps a counter for the current UTC day, so the limit is exact and global
// (unlike the location-scoped Rate Limiting binding). The day boundary matches
// the Workers AI free allocation reset at 00:00 UTC.

export const DEFAULT_DAILY_LIMIT = 1000;

export function utcDay(now = Date.now()) {
  return new Date(now).toISOString().slice(0, 10);
}

export function nextUtcMidnight(now = Date.now()) {
  const date = new Date(now);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + 1);
}

// Limit for a project: PROJECT_DAILY_LIMITS JSON override, else DAILY_REQUEST_LIMIT,
// else DEFAULT_DAILY_LIMIT. 0 disables the quota for that project.
export function dailyLimit(env, projectId) {
  try {
    const overrides = JSON.parse(env.PROJECT_DAILY_LIMITS || '{}');
    const value = Number(overrides?.[projectId]);
    if (Number.isInteger(value) && value >= 0) return value;
  } catch {
    // Ignore an invalid override and fall back to the global limit.
  }
  const global = Number(env.DAILY_REQUEST_LIMIT);
  return Number.isInteger(global) && global >= 0 ? global : DEFAULT_DAILY_LIMIT;
}

export class ProjectQuota {
  constructor(ctx) {
    this.ctx = ctx;
  }

  // POST {limit, now?} -> {allowed, count, limit, remaining, resetAt}
  async fetch(request) {
    const { limit, now = Date.now() } = await request.json();
    const day = utcDay(now);
    const stored = await this.ctx.storage.get('usage');
    const usage = stored?.day === day ? stored : { day, count: 0 };
    const resetAt = nextUtcMidnight(now);
    if (usage.count >= limit) {
      return Response.json({ allowed: false, count: usage.count, limit, remaining: 0, resetAt });
    }
    usage.count += 1;
    await this.ctx.storage.put('usage', usage);
    return Response.json({ allowed: true, count: usage.count, limit, remaining: limit - usage.count, resetAt });
  }
}

// Returns null when the quota is not configured, disabled for the project, or
// its storage fails (the request is then allowed and the failure is logged).
export async function checkDailyQuota(env, projectId) {
  if (!env.PROJECT_QUOTA) return null;
  const limit = dailyLimit(env, projectId);
  if (limit === 0) return null;
  const stub = env.PROJECT_QUOTA.get(env.PROJECT_QUOTA.idFromName(projectId));
  const response = await stub.fetch('https://project-quota/check', { method: 'POST', body: JSON.stringify({ limit }) });
  return response.json();
}
