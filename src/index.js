import { listModels, PROVIDERS, ROUTE_MODES, runGatewayChat } from './router.js';
import { toOpenAISSE } from './stream.js';

const MAX_BODY_BYTES = 128_000;
const MAX_MESSAGES = 40;
const MAX_MESSAGE_CHARS = 48_000;

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

const ERROR_TYPES = { 400: 'invalid_request_error', 401: 'authentication_error', 404: 'not_found_error', 413: 'invalid_request_error', 429: 'rate_limit_error', 503: 'api_error' };

// OpenAI-compatible error body, so official SDKs surface message and code.
function apiError(status, message, code) {
  return json({ error: { message, type: ERROR_TYPES[status] || 'api_error', code } }, status);
}

const PROJECT_KEY_PREFIX = 'PROJECT_KEY_';

// Project tokens come from the GATEWAY_PROJECT_KEYS JSON secret and from
// individual PROJECT_KEY_<NAME> secrets (PROJECT_KEY_MY_SITE -> "my-site").
// Individual secrets let a project be added without rewriting the others.
export function configuredProjectKeys(env) {
  let keys = {};
  try {
    const parsed = JSON.parse(env.GATEWAY_PROJECT_KEYS || '{}');
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) keys = { ...parsed };
  } catch {
    // An invalid JSON secret must not disable the individual project secrets.
  }
  for (const [name, value] of Object.entries(env)) {
    if (!name.startsWith(PROJECT_KEY_PREFIX) || typeof value !== 'string') continue;
    const projectId = name.slice(PROJECT_KEY_PREFIX.length).toLowerCase().replace(/_/g, '-');
    if (projectId && !(projectId in keys)) keys[projectId] = value;
  }
  return keys;
}

async function getProject(authHeader, env) {
  if (!authHeader?.startsWith('Bearer ')) return null;
  const keys = configuredProjectKeys(env);
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
      typeof message.content === 'string' && message.content.length > 0 && message.content.length <= MAX_MESSAGE_CHARS);
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

// One JSON line per chat request for Workers Logs / `wrangler tail`.
// Never includes message contents, tokens or provider keys.
function logRequest(fields) {
  console.log(JSON.stringify({ event: 'gateway_request', ...fields }));
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === 'GET' && url.pathname === '/health') return json({ ok: true, service: 'universal-ai-gateway' });
    if (request.method === 'GET' && url.pathname === '/v1/models') {
      if (!(await getProject(request.headers.get('Authorization'), env))) return apiError(401, 'Unauthorized', 'INVALID_PROJECT_TOKEN');
      return json({ object: 'list', data: listModels(env) });
    }
    if (request.method !== 'POST' || url.pathname !== '/v1/chat/completions') return apiError(404, 'Not found', 'NOT_FOUND');
    const startedAt = Date.now();
    const projectId = await getProject(request.headers.get('Authorization'), env);
    if (!projectId) return apiError(401, 'Unauthorized', 'INVALID_PROJECT_TOKEN');

    if (env.GATEWAY_RATE_LIMITER) {
      try {
        const { success } = await env.GATEWAY_RATE_LIMITER.limit({ key: projectId });
        if (!success) {
          logRequest({ project: projectId, status: 429, code: 'PROJECT_RATE_LIMIT', ms: Date.now() - startedAt });
          return apiError(429, 'Project request rate limit exceeded', 'PROJECT_RATE_LIMIT');
        }
      } catch {
        return apiError(503, 'Rate limit service unavailable', 'RATE_LIMITER_UNAVAILABLE');
      }
    }

    let body;
    try { body = await readJsonLimited(request); }
    catch (error) {
      if (error?.status === 413) return apiError(413, 'Request too large', 'REQUEST_TOO_LARGE');
      return apiError(400, 'Invalid JSON', 'INVALID_JSON');
    }
    if (!body || typeof body !== 'object' || Array.isArray(body) || !validateMessages(body.messages)) {
      return apiError(400, 'Invalid messages payload', 'INVALID_MESSAGES');
    }
    const provider = typeof body.provider === 'string' ? body.provider : 'cloudflare';
    const routeMode = typeof body.routeMode === 'string' ? body.routeMode : 'auto';
    if (!PROVIDERS.includes(provider)) return apiError(400, 'Unsupported provider', 'UNSUPPORTED_PROVIDER');
    if (!ROUTE_MODES.includes(routeMode)) return apiError(400, 'Unsupported route mode', 'UNSUPPORTED_ROUTE_MODE');
    if (body.stream !== undefined && typeof body.stream !== 'boolean') return apiError(400, 'stream must be a boolean', 'INVALID_STREAM_FLAG');
    try {
      const result = await runGatewayChat({ env, messages: body.messages, provider, routeMode, max_tokens: body.max_tokens, temperature: body.temperature, model: body.model, response_format: body.response_format, chat_template_kwargs: body.chat_template_kwargs, stream: body.stream === true, projectId });
      const id = `chatcmpl-${crypto.randomUUID()}`;
      const created = Math.floor(Date.now() / 1000);
      logRequest({
        project: projectId, requestedProvider: provider, routeMode, stream: Boolean(result.events), status: 200,
        provider: result.provider, model: result.model, fallback: result.fallback,
        ...(result.fallbackAttempts ? { fallbackAttempts: result.fallbackAttempts } : {}),
        ...(result.usage ? { usage: result.usage } : {}),
        ms: Date.now() - startedAt,
      });
      if (result.events) {
        return new Response(toOpenAISSE({ id, created, model: result.model, events: result.events }), {
          headers: {
            'Content-Type': 'text/event-stream; charset=utf-8',
            'Cache-Control': 'no-store',
            'X-Gateway-Project': projectId,
            'X-Gateway-Provider': result.provider,
            'X-Gateway-Fallback': String(result.fallback),
            ...(result.fallbackReason ? { 'X-Gateway-Fallback-Reason': result.fallbackReason } : {}),
            ...(result.fallbackAttempts ? { 'X-Gateway-Fallback-Attempts': result.fallbackAttempts.join(',') } : {}),
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
        ...(result.fallbackAttempts ? { fallbackAttempts: result.fallbackAttempts } : {}),
      });
    } catch (error) {
      const status = Number(error?.status) === 429 ? 429 : 503;
      logRequest({
        project: projectId, requestedProvider: provider, routeMode, stream: body.stream === true, status,
        code: status === 429 ? 'PROVIDER_LIMIT' : 'PROVIDER_UNAVAILABLE', error: String(error?.message || error).slice(0, 200),
        ms: Date.now() - startedAt,
      });
      return status === 429
        ? apiError(429, 'Provider quota or rate limit reached', 'PROVIDER_LIMIT')
        : apiError(503, 'No configured AI route is currently available', 'PROVIDER_UNAVAILABLE');
    }
  },
};
