import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';
import { runGatewayChat } from '../src/router.js';

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
  assert.equal((await response.json()).code, 'PROJECT_RATE_LIMIT');
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
