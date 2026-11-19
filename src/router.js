import {
  anthropicStreamEvents,
  cloudflareStreamEvents,
  mapAnthropicFinishReason,
  mapOpenAIFinishReason,
  openAIStreamEvents,
  toOpenAIUsage,
} from './stream.js';

export const DEFAULT_CF_MODEL = '@cf/meta/llama-3.1-8b-instruct-fast';
export const OPENROUTER_FREE_MODEL = 'openrouter/free';
export const DEFAULT_ANTHROPIC_MODEL = 'claude-haiku-5-5';

export function isQuotaError(error) {
  const status = Number(error?.status || error?.statusCode || 0);
  const message = String(error?.message || error || '').toLowerCase();
  return status === 429 || /quota|rate.?limit|resource.?exhausted|neurons.*limit|daily.*limit/.test(message);
}

function normalizeTextResponse(result) {
  if (typeof result === 'string') return result;
  if (typeof result?.response === 'string') return result.response;
  if (typeof result?.result?.response === 'string') return result.result.response;
  if (typeof result?.choices?.[0]?.message?.content === 'string') return result.choices[0].message.content;
  return JSON.stringify(result ?? {});
}

function openAIFinishReason(data) {
  return mapOpenAIFinishReason(data?.choices?.[0]?.finish_reason);
}

export function generationOptions({ max_tokens, temperature } = {}) {
  const options = {};
  if (Number.isInteger(max_tokens) && max_tokens > 0) options.max_tokens = Math.min(max_tokens, 8192);
  if (typeof temperature === 'number' && Number.isFinite(temperature)) options.temperature = Math.max(0, Math.min(2, temperature));
  return options;
}

function upstreamError(label, response) {
  const error = new Error(`${label} request failed (${response.status})`);
  error.status = response.status;
  return error;
}

// With `stream: true`, the result carries `events` (an async iterable of
// { text?, finishReason?, usage? }) instead of `text`/`finishReason`/`usage`.
// Upstream errors are raised before any event is produced, so quota fallback
// behaves the same for streaming and non-streaming requests.
export async function runGatewayChat({ env, messages, provider = 'cloudflare', routeMode = 'auto', max_tokens, temperature, stream = false, fetchImpl = fetch }) {
  const primary = ['cloudflare', 'openai', 'anthropic'].includes(provider) ? provider : 'cloudflare';
  if (!['auto', 'primary', 'openrouter'].includes(routeMode)) throw new Error('Unsupported route mode');
  const request = { env, messages, generation: generationOptions({ max_tokens, temperature }), stream: stream === true, fetchImpl };

  if (routeMode === 'openrouter') return runOpenRouter(request);

  try {
    if (primary === 'cloudflare') return await runCloudflare(request);
    if (primary === 'openai') return await runOpenAI(request);
    if (primary === 'anthropic') return await runAnthropic(request);
    throw new Error('Unsupported provider');
  } catch (error) {
    if (routeMode !== 'auto' || !isQuotaError(error)) throw error;
    const result = await runOpenRouter(request);
    return { ...result, fallback: true, fallbackReason: 'primary_quota_exhausted' };
  }
}

async function runCloudflare({ env, messages, generation, stream }) {
  if (!env.AI) throw new Error('Cloudflare AI binding is not configured');
  const model = env.CF_AI_MODEL || DEFAULT_CF_MODEL;
  const result = await env.AI.run(model, { messages, ...generation, ...(stream ? { stream: true } : {}) });
  if (stream) return { provider: 'cloudflare', model, events: cloudflareStreamEvents(result), fallback: false };
  return { provider: 'cloudflare', model, text: normalizeTextResponse(result), finishReason: openAIFinishReason(result), usage: toOpenAIUsage(result?.usage), fallback: false };
}

async function runOpenRouter({ env, messages, generation, stream, fetchImpl }) {
  if (env.OPENROUTER_ENABLED !== 'true' || !env.OPENROUTER_API_KEY) {
    throw new Error('OpenRouter Free fallback is not enabled or configured');
  }
  const response = await fetchImpl('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.OPENROUTER_API_KEY}`, 'Content-Type': 'application/json', 'X-Title': 'Universal AI Gateway' },
    body: JSON.stringify({ model: OPENROUTER_FREE_MODEL, messages, ...generation, ...(stream ? { stream: true } : {}) }),
  });
  if (!response.ok) throw upstreamError('OpenRouter Free', response);
  if (stream) return { provider: 'openrouter', model: OPENROUTER_FREE_MODEL, events: openAIStreamEvents(response.body), fallback: false };
  const data = await response.json();
  return { provider: 'openrouter', model: OPENROUTER_FREE_MODEL, text: normalizeTextResponse(data), finishReason: openAIFinishReason(data), usage: toOpenAIUsage(data.usage), fallback: false };
}

async function runOpenAI({ env, messages, generation, stream, fetchImpl }) {
  if (env.AI_DIRECT_PROVIDERS_ENABLED !== 'true' || env.AI_BILLING_MODE !== 'api' || !env.OPENAI_API_KEY) {
    throw new Error('OpenAI API is disabled or not configured');
  }
  const model = env.OPENAI_MODEL || 'gpt-4.1-mini';
  const response = await fetchImpl('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, messages, ...generation, ...(stream ? { stream: true, stream_options: { include_usage: true } } : {}) }),
  });
  if (!response.ok) throw upstreamError('OpenAI API', response);
  if (stream) return { provider: 'openai', model, events: openAIStreamEvents(response.body), fallback: false };
  const data = await response.json();
  return { provider: 'openai', model, text: normalizeTextResponse(data), finishReason: openAIFinishReason(data), usage: toOpenAIUsage(data.usage), fallback: false };
}

async function runAnthropic({ env, messages, generation, stream, fetchImpl }) {
  if (env.AI_DIRECT_PROVIDERS_ENABLED !== 'true' || env.AI_BILLING_MODE !== 'api' || !env.ANTHROPIC_API_KEY) {
    throw new Error('Anthropic API is disabled or not configured');
  }
  const model = env.ANTHROPIC_MODEL || DEFAULT_ANTHROPIC_MODEL;
  const system = messages.filter(message => message.role === 'system').map(message => message.content).join('\n');
  const input = messages.filter(message => message.role !== 'system');
  const response = await fetchImpl('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, max_tokens: generation.max_tokens || 2048, ...(system ? { system } : {}), messages: input, ...(stream ? { stream: true } : {}) }),
  });
  if (!response.ok) throw upstreamError('Anthropic API', response);
  if (stream) return { provider: 'anthropic', model, events: anthropicStreamEvents(response.body), fallback: false };
  const data = await response.json();
  return {
    provider: 'anthropic',
    model,
    text: (data.content || []).filter(item => item.type === 'text').map(item => item.text).join('\n'),
    finishReason: mapAnthropicFinishReason(data.stop_reason),
    usage: toOpenAIUsage({ prompt_tokens: data.usage?.input_tokens, completion_tokens: data.usage?.output_tokens }),
    fallback: false,
  };
}

// Models a project can reach with the current configuration, in OpenAI list format.
export function listModels(env) {
  const directEnabled = env.AI_DIRECT_PROVIDERS_ENABLED === 'true' && env.AI_BILLING_MODE === 'api';
  const entries = [];
  if (env.AI) entries.push({ id: env.CF_AI_MODEL || DEFAULT_CF_MODEL, owned_by: 'cloudflare' });
  if (env.OPENROUTER_ENABLED === 'true' && env.OPENROUTER_API_KEY) entries.push({ id: OPENROUTER_FREE_MODEL, owned_by: 'openrouter' });
  if (directEnabled && env.OPENAI_API_KEY) entries.push({ id: env.OPENAI_MODEL || 'gpt-4.1-mini', owned_by: 'openai' });
  if (directEnabled && env.ANTHROPIC_API_KEY) entries.push({ id: env.ANTHROPIC_MODEL || DEFAULT_ANTHROPIC_MODEL, owned_by: 'anthropic' });
  return entries.map(entry => ({ ...entry, object: 'model', created: 0 }));
}
