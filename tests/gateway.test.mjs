import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';
import { runGatewayChat } from '../src/router.js';
import { toOpenAISSE } from '../src/stream.js';

const envFor = (ai = { run: async () => ({ response: 'hello' }) }, limiter = async () => ({ success: true })) => ({
  GATEWAY_PROJECT_KEYS: JSON.stringify({ 'project-a': 'secret-a' }),
  GATEWAY_RATE_LIMITER: { limit: limiter },
  AI: ai,
});
const request = (body, token = 'secret-a') => new Request('https://gateway.test/v1/chat/completions', {
  method: 'POST',
  headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  body: typeof body === 'string' ? body : JSON.stringify(body),
});

test('health endpoint is public and does not expose configuration', async () => {
  const response = await worker.fetch(new Request('https://gateway.test/health'), {});
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, service: 'universal-ai-gateway' });
});

test('chat endpoint requires a project token', async () => {
  const response = await worker.fetch(request({ messages: [{ role: 'user', content: 'hi' }] }, ''), {});
  assert.equal(response.status, 401);
});

test('unknown project token is rejected', async () => {
  const response = await worker.fetch(request({ messages: [{ role: 'user', content: 'hi' }] }, 'wrong'), envFor());
  assert.equal(response.status, 401);
});

test('rate limit is keyed by authenticated project and returns 429 when exceeded', async () => {
  let key;
  const env = envFor(undefined, async input => { key = input.key; return { success: false }; });
  const response = await worker.fetch(request({ messages: [{ role: 'user', content: 'hi' }] }), env);
  assert.equal(response.status, 429);
  assert.equal(key, 'project-a');
  assert.deepEqual((await response.json()).error, { message: 'Project request rate limit exceeded', type: 'rate_limit_error', code: 'PROJECT_RATE_LIMIT' });
});

test('rate limiter failures fail closed', async () => {
  const env = envFor(undefined, async () => { throw new Error('binding unavailable'); });
  const response = await worker.fetch(request({ messages: [{ role: 'user', content: 'hi' }] }), env);
  assert.equal(response.status, 503);
});

test('valid project receives an OpenAI-compatible completion shape', async () => {
  const response = await worker.fetch(request({ messages: [{ role: 'user', content: 'hi' }] }), envFor());
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.equal(data.project, 'project-a');
  assert.equal(data.text, 'hello');
  assert.equal(data.provider, 'cloudflare');
  assert.equal(data.object, 'chat.completion');
  assert.equal(data.choices[0].message.role, 'assistant');
  assert.equal(data.choices[0].message.content, 'hello');
  assert.equal(data.choices[0].finish_reason, 'stop');
  assert.match(data.id, /^chatcmpl-/);
});

test('null, array, and malformed payloads are rejected without crashing', async () => {
  for (const body of ['null', '[]', '{broken']) {
    const response = await worker.fetch(request(body), envFor());
    assert.equal(response.status, 400);
  }
});

test('invalid messages are rejected', async () => {
  const response = await worker.fetch(request({ messages: [{ role: 'tool', content: 'hi' }] }), envFor());
  assert.equal(response.status, 400);
});

test('oversized request body is rejected', async () => {
  const response = await worker.fetch(request({ messages: [{ role: 'user', content: 'x'.repeat(33000) }] }), envFor());
  assert.equal(response.status, 413);
});

test('OpenRouter fallback uses fixed free model only after quota error', async () => {
  let requested;
  const env = { AI: { run: async () => { const error = new Error('quota exceeded'); error.status = 429; throw error; } }, OPENROUTER_ENABLED: 'true', OPENROUTER_API_KEY: 'test-key' };
  const result = await runGatewayChat({ env, messages: [{ role: 'user', content: 'hi' }], fetchImpl: async (url, options) => {
    requested = { url, body: JSON.parse(options.body) };
    return new Response(JSON.stringify({ choices: [{ message: { content: 'fallback answer' } }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  } });
  assert.equal(result.provider, 'openrouter');
  assert.equal(result.fallback, true);
  assert.equal(requested.body.model, 'openrouter/free');
});

test('OpenRouter is disabled by default', async () => {
  const env = { AI: { run: async () => { const error = new Error('quota exceeded'); error.status = 429; throw error; } } };
  await assert.rejects(() => runGatewayChat({ env, messages: [{ role: 'user', content: 'hi' }] }), /not enabled or configured/);
});

test('non-quota primary errors do not trigger fallback', async () => {
  const env = { AI: { run: async () => { throw new Error('bad request'); } }, OPENROUTER_ENABLED: 'true', OPENROUTER_API_KEY: 'test-key' };
  await assert.rejects(() => runGatewayChat({ env, messages: [{ role: 'user', content: 'hi' }] }), /bad request/);
});

test('paid direct providers remain disabled unless explicitly opted in', async () => {
  await assert.rejects(() => runGatewayChat({ env: { AI_BILLING_MODE: 'free', AI_DIRECT_PROVIDERS_ENABLED: 'false' }, provider: 'openai', messages: [{ role: 'user', content: 'hi' }] }), /disabled or not configured/);
});

const captureFetch = (responseBody, sink) => async (url, options) => {
  sink.url = url;
  sink.body = JSON.parse(options.body);
  return new Response(JSON.stringify(responseBody), { status: 200, headers: { 'Content-Type': 'application/json' } });
};

test('generation options are forwarded to OpenRouter', async () => {
  const sink = {};
  const env = { OPENROUTER_ENABLED: 'true', OPENROUTER_API_KEY: 'test-key' };
  await runGatewayChat({ env, routeMode: 'openrouter', messages: [{ role: 'user', content: 'hi' }], max_tokens: 99999, temperature: 5,
    fetchImpl: captureFetch({ choices: [{ message: { content: 'ok' } }] }, sink) });
  assert.equal(sink.body.max_tokens, 8192);
  assert.equal(sink.body.temperature, 2);
});

test('generation options are forwarded to OpenAI when enabled', async () => {
  const sink = {};
  const env = { AI_BILLING_MODE: 'api', AI_DIRECT_PROVIDERS_ENABLED: 'true', OPENAI_API_KEY: 'test-key' };
  await runGatewayChat({ env, provider: 'openai', routeMode: 'primary', messages: [{ role: 'user', content: 'hi' }], max_tokens: 50, temperature: 0.3,
    fetchImpl: captureFetch({ choices: [{ message: { content: 'ok' } }] }, sink) });
  assert.equal(sink.body.max_tokens, 50);
  assert.equal(sink.body.temperature, 0.3);
});

test('Anthropic receives max_tokens but never temperature', async () => {
  const sink = {};
  const env = { AI_BILLING_MODE: 'api', AI_DIRECT_PROVIDERS_ENABLED: 'true', ANTHROPIC_API_KEY: 'test-key' };
  await runGatewayChat({ env, provider: 'anthropic', routeMode: 'primary', messages: [{ role: 'user', content: 'hi' }], max_tokens: 64, temperature: 0.3,
    fetchImpl: captureFetch({ content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn' }, sink) });
  assert.equal(sink.body.max_tokens, 64);
  assert.equal('temperature' in sink.body, false);
});

test('token that only shares a prefix with a project key is rejected', async () => {
  const response = await worker.fetch(request({ messages: [{ role: 'user', content: 'hi' }] }, 'secret-a-extra'), envFor());
  assert.equal(response.status, 401);
});

test('completion includes provider usage and finish reason when available', async () => {
  const ai = { run: async () => ({ response: 'cut', usage: { prompt_tokens: 7, completion_tokens: 3 } }) };
  const response = await worker.fetch(request({ messages: [{ role: 'user', content: 'hi' }] }), envFor(ai));
  const data = await response.json();
  assert.deepEqual(data.usage, { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 });
  assert.equal(data.choices[0].finish_reason, 'stop');
});

test('Anthropic stop reasons and usage map to OpenAI fields', async () => {
  const env = { AI_BILLING_MODE: 'api', AI_DIRECT_PROVIDERS_ENABLED: 'true', ANTHROPIC_API_KEY: 'test-key' };
  const result = await runGatewayChat({ env, provider: 'anthropic', routeMode: 'primary', messages: [{ role: 'user', content: 'hi' }],
    fetchImpl: captureFetch({ content: [{ type: 'text', text: 'partial' }], stop_reason: 'max_tokens', usage: { input_tokens: 5, output_tokens: 9 } }, {}) });
  assert.equal(result.finishReason, 'length');
  assert.deepEqual(result.usage, { prompt_tokens: 5, completion_tokens: 9, total_tokens: 14 });
});

test('OpenRouter length finish reason is preserved', async () => {
  const env = { OPENROUTER_ENABLED: 'true', OPENROUTER_API_KEY: 'test-key' };
  const result = await runGatewayChat({ env, routeMode: 'openrouter', messages: [{ role: 'user', content: 'hi' }],
    fetchImpl: captureFetch({ choices: [{ message: { content: 'x' }, finish_reason: 'length' }] }, {}) });
  assert.equal(result.finishReason, 'length');
  assert.equal(result.usage, undefined);
});

test('Anthropic defaults to the current Haiku model', async () => {
  const sink = {};
  const env = { AI_BILLING_MODE: 'api', AI_DIRECT_PROVIDERS_ENABLED: 'true', ANTHROPIC_API_KEY: 'test-key' };
  const result = await runGatewayChat({ env, provider: 'anthropic', routeMode: 'primary', messages: [{ role: 'user', content: 'hi' }],
    fetchImpl: captureFetch({ content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn' }, sink) });
  assert.equal(sink.body.model, 'claude-haiku-5-5');
  assert.equal(result.model, 'claude-haiku-5-5');
});

const sseBody = lines => new ReadableStream({
  start(controller) {
    const encoder = new TextEncoder();
    // Split mid-line to exercise buffering across chunks.
    const text = lines.map(line => `data: ${typeof line === 'string' ? line : JSON.stringify(line)}\n\n`).join('');
    const middle = Math.floor(text.length / 2);
    controller.enqueue(encoder.encode(text.slice(0, middle)));
    controller.enqueue(encoder.encode(text.slice(middle)));
    controller.close();
  },
});
const readSSEPayloads = async response => (await response.text()).split('\n\n').filter(Boolean).map(block => block.replace(/^data: /, ''));

test('streaming Workers AI responses are re-emitted as OpenAI chunks', async () => {
  let options;
  const ai = { run: async (model, input) => { options = input; return sseBody([{ response: 'Hel' }, { response: 'lo' }, { response: '', usage: { prompt_tokens: 4, completion_tokens: 2 } }, '[DONE]']); } };
  const response = await worker.fetch(request({ stream: true, messages: [{ role: 'user', content: 'hi' }] }), envFor(ai));
  assert.equal(response.status, 200);
  assert.match(response.headers.get('Content-Type'), /text\/event-stream/);
  assert.equal(response.headers.get('X-Gateway-Provider'), 'cloudflare');
  assert.equal(options.stream, true);
  const payloads = await readSSEPayloads(response);
  assert.equal(payloads.at(-1), '[DONE]');
  const chunks = payloads.slice(0, -1).map(payload => JSON.parse(payload));
  assert.ok(chunks.every(chunk => chunk.object === 'chat.completion.chunk' && chunk.id === chunks[0].id));
  assert.equal(chunks[0].choices[0].delta.role, 'assistant');
  assert.equal(chunks.map(chunk => chunk.choices[0].delta.content || '').join(''), 'Hello');
  assert.equal(chunks.at(-1).choices[0].finish_reason, 'stop');
  assert.deepEqual(chunks.at(-1).usage, { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 });
});

test('non-boolean stream flag is rejected', async () => {
  const response = await worker.fetch(request({ stream: 'yes', messages: [{ role: 'user', content: 'hi' }] }), envFor());
  assert.equal(response.status, 400);
});

test('streaming quota errors still fall back to OpenRouter before the first byte', async () => {
  let requested;
  const env = { AI: { run: async () => { const error = new Error('quota exceeded'); error.status = 429; throw error; } }, OPENROUTER_ENABLED: 'true', OPENROUTER_API_KEY: 'test-key' };
  const result = await runGatewayChat({ env, stream: true, messages: [{ role: 'user', content: 'hi' }], fetchImpl: async (url, options) => {
    requested = JSON.parse(options.body);
    return new Response(sseBody([{ choices: [{ delta: { content: 'ok' } }] }, { choices: [{ delta: {}, finish_reason: 'length' }] }, '[DONE]']), { status: 200 });
  } });
  assert.equal(result.fallback, true);
  assert.equal(requested.stream, true);
  const events = [];
  for await (const event of result.events) events.push(event);
  assert.equal(events.map(event => event.text || '').join(''), 'ok');
  assert.equal(events.at(-1).finishReason, 'length');
});

test('Anthropic stream events map to text, finish reason, and usage', async () => {
  const env = { AI_BILLING_MODE: 'api', AI_DIRECT_PROVIDERS_ENABLED: 'true', ANTHROPIC_API_KEY: 'test-key' };
  const result = await runGatewayChat({ env, provider: 'anthropic', routeMode: 'primary', stream: true, messages: [{ role: 'user', content: 'hi' }], fetchImpl: async () => new Response(sseBody([
    { type: 'message_start', message: { usage: { input_tokens: 3 } } },
    { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hi' } },
    { type: 'content_block_delta', delta: { type: 'text_delta', text: ' there' } },
    { type: 'message_delta', delta: { stop_reason: 'max_tokens' }, usage: { output_tokens: 2 } },
    { type: 'message_stop' },
  ]), { status: 200 }) });
  const response = new Response(toOpenAISSE({ id: 'chatcmpl-test', created: 0, model: result.model, events: result.events }));
  const chunks = (await readSSEPayloads(response)).slice(0, -1).map(payload => JSON.parse(payload));
  assert.equal(chunks.map(chunk => chunk.choices[0].delta.content || '').join(''), 'Hi there');
  assert.equal(chunks.at(-1).choices[0].finish_reason, 'length');
  assert.deepEqual(chunks.at(-1).usage, { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 });
});

test('mid-stream upstream errors end the stream with an error event', async () => {
  const events = (async function* () { yield { text: 'partial' }; throw new Error('socket closed'); })();
  const payloads = await readSSEPayloads(new Response(toOpenAISSE({ id: 'chatcmpl-test', created: 0, model: 'm', events })));
  assert.equal(JSON.parse(payloads.at(-2)).error.code, 'STREAM_INTERRUPTED');
  assert.equal(payloads.at(-1), '[DONE]');
});

test('models endpoint requires a token and lists only configured routes', async () => {
  const listRequest = token => new Request('https://gateway.test/v1/models', { headers: token ? { Authorization: `Bearer ${token}` } : {} });
  assert.equal((await worker.fetch(listRequest(), envFor())).status, 401);
  const response = await worker.fetch(listRequest('secret-a'), envFor());
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.equal(data.object, 'list');
  assert.deepEqual(data.data.map(model => model.id), ['@cf/meta/llama-3.1-8b-instruct-fast']);
  assert.equal(data.data[0].object, 'model');
});

test('unknown routes return an OpenAI-style 404 error', async () => {
  const response = await worker.fetch(new Request('https://gateway.test/v1/embeddings', { method: 'POST' }), envFor());
  assert.equal(response.status, 404);
  assert.equal((await response.json()).error.code, 'NOT_FOUND');
});

test('Workers AI replies that exhaust max_tokens report finish_reason length', async () => {
  const ai = { run: async () => ({ response: 'cut', usage: { prompt_tokens: 5, completion_tokens: 30 } }) };
  const response = await worker.fetch(request({ max_tokens: 30, messages: [{ role: 'user', content: 'hi' }] }), envFor(ai));
  assert.equal((await response.json()).choices[0].finish_reason, 'length');
});

test('Workers AI default token budget is used when max_tokens is omitted', async () => {
  const ai = { run: async () => ({ response: 'long', usage: { prompt_tokens: 5, completion_tokens: 256 } }) };
  const response = await worker.fetch(request({ messages: [{ role: 'user', content: 'hi' }] }), envFor(ai));
  assert.equal((await response.json()).choices[0].finish_reason, 'length');
});

test('streamed Workers AI replies that exhaust max_tokens end with length', async () => {
  const ai = { run: async () => sseBody([{ response: 'a' }, { response: '', usage: { prompt_tokens: 1, completion_tokens: 10 } }, '[DONE]']) };
  const response = await worker.fetch(request({ stream: true, max_tokens: 10, messages: [{ role: 'user', content: 'hi' }] }), envFor(ai));
  const payloads = await readSSEPayloads(response);
  assert.equal(JSON.parse(payloads.at(-2)).choices[0].finish_reason, 'length');
});

const quotaAI = { run: async () => { const error = new Error('neurons daily limit'); error.status = 429; throw error; } };
const chainFetch = (outcomes, calls) => async url => {
  const host = new URL(url).hostname;
  calls.push(host);
  const outcome = outcomes[host] ?? 200;
  if (outcome !== 200) return new Response('{}', { status: outcome });
  return new Response(JSON.stringify({ choices: [{ message: { content: `from ${host}` }, finish_reason: 'stop' }] }), { status: 200 });
};

test('fallback chain skips unconfigured providers and moves past exhausted ones', async () => {
  const calls = [];
  const env = { AI: quotaAI, FALLBACK_CHAIN: 'groq,cerebras,gemini', GROQ_API_KEY: 'g', GEMINI_API_KEY: 'm' };
  const result = await runGatewayChat({ env, messages: [{ role: 'user', content: 'hi' }],
    fetchImpl: chainFetch({ 'api.groq.com': 429 }, calls) });
  assert.deepEqual(calls, ['api.groq.com', 'generativelanguage.googleapis.com']);
  assert.equal(result.provider, 'gemini');
  assert.equal(result.text, 'from generativelanguage.googleapis.com');
  assert.equal(result.fallback, true);
  assert.deepEqual(result.fallbackAttempts, ['groq', 'gemini']);
});

test('fallback chain continues past unavailable providers too', async () => {
  const calls = [];
  const env = { AI: quotaAI, FALLBACK_CHAIN: 'mistral,groq', MISTRAL_API_KEY: 'x', GROQ_API_KEY: 'g' };
  const result = await runGatewayChat({ env, messages: [{ role: 'user', content: 'hi' }],
    fetchImpl: chainFetch({ 'api.mistral.ai': 500 }, calls) });
  assert.equal(result.provider, 'groq');
});

test('fallback chain order is configurable and ignores unknown or paid providers', async () => {
  const calls = [];
  const env = { AI: quotaAI, FALLBACK_CHAIN: ' OpenAI , github, nope, groq ', GITHUB_MODELS_TOKEN: 't', GROQ_API_KEY: 'g',
    AI_BILLING_MODE: 'api', AI_DIRECT_PROVIDERS_ENABLED: 'true', OPENAI_API_KEY: 'k' };
  const result = await runGatewayChat({ env, messages: [{ role: 'user', content: 'hi' }], fetchImpl: chainFetch({}, calls) });
  assert.deepEqual(calls, ['models.github.ai']);
  assert.equal(result.provider, 'github');
});

test('exhausted fallback chain returns PROVIDER_LIMIT', async () => {
  const env = { ...envFor(quotaAI), FALLBACK_CHAIN: 'groq', GROQ_API_KEY: 'g' };
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response('{}', { status: 429 });
  try {
    const response = await worker.fetch(request({ messages: [{ role: 'user', content: 'hi' }] }), env);
    assert.equal(response.status, 429);
    assert.equal((await response.json()).error.code, 'PROVIDER_LIMIT');
  } finally {
    globalThis.fetch = original;
  }
});

test('chain providers can be selected directly and appear in the models list', async () => {
  const calls = [];
  const env = { GROQ_API_KEY: 'g', GROQ_MODEL: 'llama-test' };
  const result = await runGatewayChat({ env, provider: 'groq', routeMode: 'primary', messages: [{ role: 'user', content: 'hi' }], fetchImpl: chainFetch({}, calls) });
  assert.equal(result.provider, 'groq');
  assert.equal(result.model, 'llama-test');
  const response = await worker.fetch(new Request('https://gateway.test/v1/models', { headers: { Authorization: 'Bearer secret-a' } }), { ...envFor(), ...env });
  assert.ok((await response.json()).data.some(model => model.owned_by === 'groq' && model.id === 'llama-test'));
});

test('unknown provider names are rejected', async () => {
  const response = await worker.fetch(request({ provider: 'skynet', messages: [{ role: 'user', content: 'hi' }] }), envFor());
  assert.equal(response.status, 400);
});
