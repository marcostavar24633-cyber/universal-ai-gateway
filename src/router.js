import {
  anthropicStreamEvents,
  cloudflareFinishReason,
  cloudflareStreamEvents,
  mapAnthropicFinishReason,
  mapOpenAIFinishReason,
  openAIStreamEvents,
  toOpenAIUsage,
} from './stream.js';

export const DEFAULT_CF_MODEL = '@cf/meta/llama-3.1-8b-instruct-fast';
export const OPENROUTER_FREE_MODEL = 'openrouter/free';
export const DEFAULT_ANTHROPIC_MODEL = 'claude-haiku-5-5';
// Workers AI applies this output limit when max_tokens is not sent.
export const CF_DEFAULT_MAX_TOKENS = 256;
// A request may pick any Workers AI model by its @cf/ id; other model names
// (for example the "gpt-4o" OpenAI SDKs send by default) are ignored.
const CF_MODEL_PATTERN = /^@cf\/[\w-][\w.-]*\/[\w-][\w.:-]*$/;

export function cloudflareModel(env, requested) {
  return typeof requested === 'string' && CF_MODEL_PATTERN.test(requested) ? requested : env.CF_AI_MODEL || DEFAULT_CF_MODEL;
}

export const DEFAULT_FALLBACK_CHAIN = 'groq,cerebras,gemini,mistral,openrouter';
export const ROUTE_MODES = ['auto', 'primary', 'openrouter'];
// How long to wait for a provider to start responding before giving up on it.
export const DEFAULT_PROVIDER_TIMEOUT_MS = 25_000;

const directProvidersEnabled = env => env.AI_DIRECT_PROVIDERS_ENABLED === 'true' && env.AI_BILLING_MODE === 'api';

// OpenAI-compatible chat completion providers. A provider is used only when
// `enabled(env)` is true; free-tier providers are enabled by setting their key.
export const OPENAI_COMPATIBLE_PROVIDERS = {
  groq: {
    label: 'Groq', url: 'https://api.groq.com/openai/v1/chat/completions',
    key: env => env.GROQ_API_KEY, model: env => env.GROQ_MODEL || 'openai/gpt-oss-120b',
    enabled: env => Boolean(env.GROQ_API_KEY),
  },
  cerebras: {
    label: 'Cerebras', url: 'https://api.cerebras.ai/v1/chat/completions',
    key: env => env.CEREBRAS_API_KEY, model: env => env.CEREBRAS_MODEL || 'llama-3.3-70b',
    enabled: env => Boolean(env.CEREBRAS_API_KEY),
  },
  gemini: {
    label: 'Gemini', url: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
    key: env => env.GEMINI_API_KEY, model: env => env.GEMINI_MODEL || 'gemini-flash-latest',
    enabled: env => Boolean(env.GEMINI_API_KEY),
  },
  mistral: {
    label: 'Mistral', url: 'https://api.mistral.ai/v1/chat/completions',
    key: env => env.MISTRAL_API_KEY, model: env => env.MISTRAL_MODEL || 'mistral-small-latest',
    enabled: env => Boolean(env.MISTRAL_API_KEY),
  },
  openrouter: {
    label: 'OpenRouter Free', url: 'https://openrouter.ai/api/v1/chat/completions',
    key: env => env.OPENROUTER_API_KEY, model: () => OPENROUTER_FREE_MODEL,
    enabled: env => env.OPENROUTER_ENABLED === 'true' && Boolean(env.OPENROUTER_API_KEY),
    disabledMessage: 'OpenRouter Free fallback is not enabled or configured',
    headers: { 'X-Title': 'Universal AI Gateway' },
  },
  openai: {
    label: 'OpenAI API', url: 'https://api.openai.com/v1/chat/completions',
    key: env => env.OPENAI_API_KEY, model: env => env.OPENAI_MODEL || 'gpt-4.1-mini',
    enabled: env => directProvidersEnabled(env) && Boolean(env.OPENAI_API_KEY),
    disabledMessage: 'OpenAI API is disabled or not configured',
    streamOptions: { stream_options: { include_usage: true } },
  },
};

export const PROVIDERS = ['cloudflare', 'anthropic', ...Object.keys(OPENAI_COMPATIBLE_PROVIDERS)];
const FALLBACK_PROVIDERS = new Set(['groq', 'cerebras', 'gemini', 'mistral', 'openrouter']);

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

// Aborts the request if response headers do not arrive in time. Once they do,
// the timer is cleared so long streaming bodies are not cut off.
async function fetchWithTimeout(fetchImpl, url, options, env, label) {
  const timeoutMs = Number(env.PROVIDER_TIMEOUT_MS) > 0 ? Number(env.PROVIDER_TIMEOUT_MS) : DEFAULT_PROVIDER_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, { ...options, signal: controller.signal });
  } catch (error) {
    if (controller.signal.aborted) {
      const timeoutError = new Error(`${label} did not respond within ${timeoutMs} ms`);
      timeoutError.status = 504;
      throw timeoutError;
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function upstreamError(label, response) {
  const error = new Error(`${label} request failed (${response.status})`);
  error.status = response.status;
  return error;
}

// Fallback providers from FALLBACK_CHAIN, in order, without duplicates or unknown names.
export function fallbackChain(env) {
  const names = String(env.FALLBACK_CHAIN ?? DEFAULT_FALLBACK_CHAIN).split(',').map(name => name.trim().toLowerCase());
  return [...new Set(names)].filter(name => FALLBACK_PROVIDERS.has(name));
}

// With `stream: true`, the result carries `events` (an async iterable of
// { text?, finishReason?, usage? }) instead of `text`/`finishReason`/`usage`.
// Upstream errors are raised before any event is produced, so fallback
// behaves the same for streaming and non-streaming requests.
export async function runGatewayChat({ env, messages, provider = 'cloudflare', routeMode = 'auto', max_tokens, temperature, model, stream = false, fetchImpl = fetch }) {
  const primary = PROVIDERS.includes(provider) ? provider : 'cloudflare';
  if (!ROUTE_MODES.includes(routeMode)) throw new Error('Unsupported route mode');
  const request = { env, messages, generation: generationOptions({ max_tokens, temperature }), model, stream: stream === true, fetchImpl };

  if (routeMode === 'openrouter') return runProvider('openrouter', request);

  try {
    return await runProvider(primary, request);
  } catch (error) {
    if (routeMode !== 'auto' || !isQuotaError(error)) throw error;
    return runFallbackChain(primary, request);
  }
}

// Tries each configured fallback provider in order. Providers without keys are
// skipped; a provider that is out of quota or unavailable hands over to the next.
async function runFallbackChain(primary, request) {
  const candidates = fallbackChain(request.env).filter(name => name !== primary && OPENAI_COMPATIBLE_PROVIDERS[name].enabled(request.env));
  const attempted = [];
  let lastError;
  for (const name of candidates) {
    attempted.push(name);
    try {
      const result = await runProvider(name, request);
      return { ...result, fallback: true, fallbackReason: 'primary_quota_exhausted', fallbackAttempts: attempted };
    } catch (error) {
      lastError = error;
    }
  }
  const error = new Error(candidates.length ? 'All fallback providers failed' : 'No fallback provider available: all are not enabled or configured');
  error.status = !lastError || isQuotaError(lastError) ? 429 : 503;
  throw error;
}

function runProvider(name, request) {
  if (name === 'cloudflare') return runCloudflare(request);
  if (name === 'anthropic') return runAnthropic(request);
  const config = OPENAI_COMPATIBLE_PROVIDERS[name];
  if (!config) throw new Error('Unsupported provider');
  return runOpenAICompatible(name, config, request);
}

async function runCloudflare({ env, messages, generation, model: requestedModel, stream }) {
  if (!env.AI) throw new Error('Cloudflare AI binding is not configured');
  const model = cloudflareModel(env, requestedModel);
  const result = await env.AI.run(model, { messages, ...generation, ...(stream ? { stream: true } : {}) });
  const maxTokens = generation.max_tokens || CF_DEFAULT_MAX_TOKENS;
  if (stream) return { provider: 'cloudflare', model, events: cloudflareStreamEvents(result, maxTokens), fallback: false };
  const usage = toOpenAIUsage(result?.usage);
  return { provider: 'cloudflare', model, text: normalizeTextResponse(result), finishReason: cloudflareFinishReason(usage, maxTokens), usage, fallback: false };
}

async function runOpenAICompatible(name, config, { env, messages, generation, stream, fetchImpl }) {
  if (!config.enabled(env)) throw new Error(config.disabledMessage || `${config.label} is not enabled or configured`);
  const model = config.model(env);
  const response = await fetchWithTimeout(fetchImpl, config.url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${config.key(env)}`, 'Content-Type': 'application/json', ...(config.headers || {}) },
    body: JSON.stringify({ model, messages, ...generation, ...(stream ? { stream: true, ...(config.streamOptions || {}) } : {}) }),
  }, env, config.label);
  if (!response.ok) throw upstreamError(config.label, response);
  if (stream) return { provider: name, model, events: openAIStreamEvents(response.body), fallback: false };
  const data = await response.json();
  return { provider: name, model, text: normalizeTextResponse(data), finishReason: openAIFinishReason(data), usage: toOpenAIUsage(data.usage), fallback: false };
}

async function runAnthropic({ env, messages, generation, stream, fetchImpl }) {
  if (!directProvidersEnabled(env) || !env.ANTHROPIC_API_KEY) {
    throw new Error('Anthropic API is disabled or not configured');
  }
  const model = env.ANTHROPIC_MODEL || DEFAULT_ANTHROPIC_MODEL;
  const system = messages.filter(message => message.role === 'system').map(message => message.content).join('\n');
  const input = messages.filter(message => message.role !== 'system');
  const response = await fetchWithTimeout(fetchImpl, 'https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, max_tokens: generation.max_tokens || 2048, ...(system ? { system } : {}), messages: input, ...(stream ? { stream: true } : {}) }),
  }, env, 'Anthropic API');
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
  const entries = [];
  if (env.AI) entries.push({ id: env.CF_AI_MODEL || DEFAULT_CF_MODEL, owned_by: 'cloudflare' });
  for (const [name, config] of Object.entries(OPENAI_COMPATIBLE_PROVIDERS)) {
    if (config.enabled(env)) entries.push({ id: config.model(env), owned_by: name });
  }
  if (directProvidersEnabled(env) && env.ANTHROPIC_API_KEY) entries.push({ id: env.ANTHROPIC_MODEL || DEFAULT_ANTHROPIC_MODEL, owned_by: 'anthropic' });
  return entries.map(entry => ({ ...entry, object: 'model', created: 0 }));
}
