import { runGatewayChat } from './router.js';
import { toOpenAISSE } from './stream.js';

const MAX_BODY_BYTES = 32_000;
const MAX_MESSAGES = 40;

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } });
}

async function sha256(value) {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)));
}

// Compares fixed-length digests so timing does not reveal how much of a token matched.
function digestsEqual(a, b) {
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

async function getProject(authHeader, env) {
  if (!authHeader?.startsWith('Bearer ')) return null;
  let keys;
  try { keys = JSON.parse(env.GATEWAY_PROJECT_KEYS || '{}'); } catch { return null; }
  const token = authHeader.slice(7).trim();
  if (!token || token.length > 256) return null;
  const tokenDigest = await sha256(token);
  let match = null;
  for (const [projectId, configuredToken] of Object.entries(keys)) {
    if (typeof configuredToken !== 'string' || !configuredToken.length) continue;
    if (digestsEqual(tokenDigest, await sha256(configuredToken)) && match === null) match = projectId;
  }
  return match;
}

function validateMessages(messages) {
  return Array.isArray(messages) && messages.length > 0 && messages.length <= MAX_MESSAGES &&
    messages.every(message => message && ['system', 'user', 'assistant'].includes(message.role) &&
      typeof message.content === 'string' && message.content.length > 0 && message.content.length <= 12000);
}

async function readJsonLimited(request) {
  const reader = request.body?.getReader();
  if (!reader) throw new Error('Missing request body');
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BODY_BYTES) {
      await reader.cancel();
      const error = new Error('Request too large');
      error.status = 413;
      throw error;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return JSON.parse(new TextDecoder().decode(bytes));
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === 'GET' && url.pathname === '/health') return json({ ok: true, service: 'universal-ai-gateway' });
    if (request.method !== 'POST' || url.pathname !== '/v1/chat/completions') return json({ error: 'Not found' }, 404);
    const projectId = await getProject(request.headers.get('Authorization'), env);
    if (!projectId) return json({ error: 'Unauthorized' }, 401);

    if (env.GATEWAY_RATE_LIMITER) {
      try {
        const { success } = await env.GATEWAY_RATE_LIMITER.limit({ key: projectId });
        if (!success) return json({ error: 'Project request rate limit exceeded', code: 'PROJECT_RATE_LIMIT' }, 429);
      } catch {
        return json({ error: 'Rate limit service unavailable' }, 503);
      }
    }

    let body;
    try { body = await readJsonLimited(request); }
    catch (error) {
      if (error?.status === 413) return json({ error: 'Request too large' }, 413);
      return json({ error: 'Invalid JSON' }, 400);
    }
    if (!body || typeof body !== 'object' || Array.isArray(body) || !validateMessages(body.messages)) {
      return json({ error: 'Invalid messages payload' }, 400);
    }
    const provider = typeof body.provider === 'string' ? body.provider : 'cloudflare';
    const routeMode = typeof body.routeMode === 'string' ? body.routeMode : 'auto';
    if (!['cloudflare', 'openai', 'anthropic'].includes(provider)) return json({ error: 'Unsupported provider' }, 400);
    if (!['auto', 'primary', 'openrouter'].includes(routeMode)) return json({ error: 'Unsupported route mode' }, 400);
    if (body.stream !== undefined && typeof body.stream !== 'boolean') return json({ error: 'stream must be a boolean' }, 400);
    try {
      const result = await runGatewayChat({ env, messages: body.messages, provider, routeMode, max_tokens: body.max_tokens, temperature: body.temperature, stream: body.stream === true });
      const id = `chatcmpl-${crypto.randomUUID()}`;
      const created = Math.floor(Date.now() / 1000);
      if (result.events) {
        return new Response(toOpenAISSE({ id, created, model: result.model, events: result.events }), {
          headers: {
            'Content-Type': 'text/event-stream; charset=utf-8',
            'Cache-Control': 'no-store',
            'X-Gateway-Project': projectId,
            'X-Gateway-Provider': result.provider,
            'X-Gateway-Fallback': String(result.fallback),
            ...(result.fallbackReason ? { 'X-Gateway-Fallback-Reason': result.fallbackReason } : {}),
          },
        });
      }
      return json({
        id,
        object: 'chat.completion',
        created,
        model: result.model,
        choices: [{ index: 0, message: { role: 'assistant', content: result.text }, finish_reason: result.finishReason || 'stop' }],
        ...(result.usage ? { usage: result.usage } : {}),
        project: projectId,
        provider: result.provider,
        text: result.text,
        fallback: result.fallback,
        ...(result.fallbackReason ? { fallbackReason: result.fallbackReason } : {}),
      });
    } catch (error) {
      const status = Number(error?.status) === 429 ? 429 : 503;
      return json({ error: status === 429 ? 'Provider quota or rate limit reached' : 'No configured AI route is currently available', code: status === 429 ? 'PROVIDER_LIMIT' : 'PROVIDER_UNAVAILABLE' }, status);
    }
  },
};
