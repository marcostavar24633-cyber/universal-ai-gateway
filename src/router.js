export const DEFAULT_CF_MODEL = '@cf/meta/llama-3.1-8b-instruct-fast';
export const OPENROUTER_FREE_MODEL = 'openrouter/free';

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

const OPENAI_FINISH_REASONS = new Set(['stop', 'length', 'content_filter', 'tool_calls']);
const ANTHROPIC_FINISH_REASONS = { end_turn: 'stop', stop_sequence: 'stop', max_tokens: 'length', refusal: 'content_filter' };

function openAIFinishReason(data) {
  const reason = data?.choices?.[0]?.finish_reason;
  return OPENAI_FINISH_REASONS.has(reason) ? reason : 'stop';
}

function openAIUsage(usage) {
  const prompt = Number(usage?.prompt_tokens);
  const completion = Number(usage?.completion_tokens);
  if (!Number.isFinite(prompt) || !Number.isFinite(completion)) return undefined;
  return { prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion };
}

export function generationOptions({ max_tokens, temperature } = {}) {
  const options = {};
  if (Number.isInteger(max_tokens) && max_tokens > 0) options.max_tokens = Math.min(max_tokens, 8192);
  if (typeof temperature === 'number' && Number.isFinite(temperature)) options.temperature = Math.max(0, Math.min(2, temperature));
  return options;
}

export async function runGatewayChat({ env, messages, provider = 'cloudflare', routeMode = 'auto', max_tokens, temperature, fetchImpl = fetch }) {
  const primary = ['cloudflare', 'openai', 'anthropic'].includes(provider) ? provider : 'cloudflare';
  if (!['auto', 'primary', 'openrouter'].includes(routeMode)) throw new Error('Unsupported route mode');
  const generation = generationOptions({ max_tokens, temperature });

  if (routeMode === 'openrouter') return runOpenRouter({ env, messages, generation, fetchImpl });

  try {
    if (primary === 'cloudflare') {
      if (!env.AI) throw new Error('Cloudflare AI binding is not configured');
      const result = await env.AI.run(env.CF_AI_MODEL || DEFAULT_CF_MODEL, { messages, ...generation });
      return { provider: 'cloudflare', model: env.CF_AI_MODEL || DEFAULT_CF_MODEL, text: normalizeTextResponse(result), finishReason: openAIFinishReason(result), usage: openAIUsage(result?.usage), fallback: false };
    }
    if (primary === 'openai') return await runOpenAI({ env, messages, generation, fetchImpl });
    if (primary === 'anthropic') return await runAnthropic({ env, messages, generation, fetchImpl });
    throw new Error('Unsupported provider');
  } catch (error) {
    if (routeMode !== 'auto' || !isQuotaError(error)) throw error;
    const result = await runOpenRouter({ env, messages, generation, fetchImpl });
    return { ...result, fallback: true, fallbackReason: 'primary_quota_exhausted' };
  }
}

async function runOpenRouter({ env, messages, generation = {}, fetchImpl }) {
  if (env.OPENROUTER_ENABLED !== 'true' || !env.OPENROUTER_API_KEY) {
    throw new Error('OpenRouter Free fallback is not enabled or configured');
  }
  const response = await fetchImpl('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.OPENROUTER_API_KEY}`, 'Content-Type': 'application/json', 'X-Title': 'Universal AI Gateway' },
    body: JSON.stringify({ model: OPENROUTER_FREE_MODEL, messages, ...generation }),
  });
  if (!response.ok) {
    const error = new Error(`OpenRouter Free request failed (${response.status})`);
    error.status = response.status;
    throw error;
  }
  const data = await response.json();
  return { provider: 'openrouter', model: OPENROUTER_FREE_MODEL, text: normalizeTextResponse(data), finishReason: openAIFinishReason(data), usage: openAIUsage(data.usage), fallback: false };
}

async function runOpenAI({ env, messages, generation = {}, fetchImpl }) {
  if (env.AI_DIRECT_PROVIDERS_ENABLED !== 'true' || env.AI_BILLING_MODE !== 'api' || !env.OPENAI_API_KEY) {
    throw new Error('OpenAI API is disabled or not configured');
  }
  const response = await fetchImpl('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: env.OPENAI_MODEL || 'gpt-4.1-mini', messages, ...generation }),
  });
  if (!response.ok) { const error = new Error(`OpenAI API request failed (${response.status})`); error.status = response.status; throw error; }
  const data = await response.json();
  return { provider: 'openai', model: env.OPENAI_MODEL || 'gpt-4.1-mini', text: normalizeTextResponse(data), finishReason: openAIFinishReason(data), usage: openAIUsage(data.usage), fallback: false };
}

async function runAnthropic({ env, messages, generation = {}, fetchImpl }) {
  if (env.AI_DIRECT_PROVIDERS_ENABLED !== 'true' || env.AI_BILLING_MODE !== 'api' || !env.ANTHROPIC_API_KEY) {
    throw new Error('Anthropic API is disabled or not configured');
  }
  const system = messages.filter(message => message.role === 'system').map(message => message.content).join('\n');
  const input = messages.filter(message => message.role !== 'system');
  const response = await fetchImpl('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: env.ANTHROPIC_MODEL || 'claude-3-5-haiku-latest', max_tokens: generation.max_tokens || 2048, ...(system ? { system } : {}), messages: input }),
  });
  if (!response.ok) { const error = new Error(`Anthropic API request failed (${response.status})`); error.status = response.status; throw error; }
  const data = await response.json();
  return { provider: 'anthropic', model: env.ANTHROPIC_MODEL || 'claude-3-5-haiku-latest', text: (data.content || []).filter(item => item.type === 'text').map(item => item.text).join('\n'),
    finishReason: ANTHROPIC_FINISH_REASONS[data.stop_reason] || 'stop',
    usage: openAIUsage({ prompt_tokens: data.usage?.input_tokens, completion_tokens: data.usage?.output_tokens }),
    fallback: false };
}
