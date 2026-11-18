import { runGatewayChat } from './router.js';

const MAX_BODY_BYTES = 32_000;
const MAX_MESSAGES = 40;

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } });
}

function getProject(authHeader, env) {
  if (!authHeader?.startsWith('Bearer ')) return null;
  let keys;
  try { keys = JSON.parse(env.GATEWAY_PROJECT_KEYS || '{}'); } catch { return null; }
  const token = authHeader.slice(7).trim();
  if (!token || token.length > 256) return null;
  for (const [projectId, configuredToken] of Object.entries(keys)) {
    if (typeof configuredToken === 'string' && configuredToken.length && configuredToken === token) return projectId;
  }
  return null;
}

function validateMessages(messages) {
  return Array.isArray(messages) && messages.length > 0 && messages.length <= MAX_MESSAGES &&
    messages.every(message => message && ['system', 'user', 'assistant'].includes(message.role) &&
      typeof message.content === 'string' && message.content.length > 0 && message.content.length <= 12000);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === 'GET' && url.pathname === '/health') return json({ ok: true, service: 'universal-ai-gateway' });
    if (request.method !== 'POST' || url.pathname !== '/v1/chat/completions') return json({ error: 'Not found' }, 404);

    const projectId = getProject(request.headers.get('Authorization'), env);
    if (!projectId) return json({ error: 'Unauthorized' }, 401);
    const declaredLength = Number(request.headers.get('Content-Length') || 0);
    if (declaredLength > MAX_BODY_BYTES) return json({ error: 'Request too large' }, 413);

    let body;
    try { body = await request.json(); } catch { return json({ error: 'Invalid JSON' }, 400); }
    if (!validateMessages(body.messages)) return json({ error: 'Invalid messages payload' }, 400);

    const provider = typeof body.provider === 'string' ? body.provider : 'cloudflare';
    const routeMode = typeof body.routeMode === 'string' ? body.routeMode : 'auto';
    try {
      const result = await runGatewayChat({ env, messages: body.messages, provider, routeMode });
      return json({ id: crypto.randomUUID(), project: projectId, object: 'chat.completion', ...result });
    } catch (error) {
      const status = Number(error?.status) === 429 ? 429 : 503;
      return json({ error: status === 429 ? 'Provider quota or rate limit reached' : 'No configured AI route is currently available', code: status === 429 ? 'PROVIDER_LIMIT' : 'PROVIDER_UNAVAILABLE' }, status);
    }
  },
};
