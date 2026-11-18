import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';
import { runGatewayChat } from '../src/router.js';

test('health endpoint is public and does not expose configuration', async () => {
  const response = await worker.fetch(new Request('https://gateway.test/health'), {});
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, service: 'universal-ai-gateway' });
});

test('chat endpoint requires a project token', async () => {
  const response = await worker.fetch(new Request('https://gateway.test/v1/chat/completions', { method: 'POST', body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }) }), {});
  assert.equal(response.status, 401);
});

test('unknown project token is rejected', async () => {
  const env = { GATEWAY_PROJECT_KEYS: JSON.stringify({ 'project-a': 'secret-a' }) };
  const response = await worker.fetch(new Request('https://gateway.test/v1/chat/completions', { method: 'POST', headers: { Authorization: 'Bearer wrong' }, body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }) }), env);
  assert.equal(response.status, 401);
});

test('valid project can call Cloudflare AI', async () => {
  const env = { GATEWAY_PROJECT_KEYS: JSON.stringify({ 'project-a': 'secret-a' }), AI: { run: async () => ({ response: 'hello' }) } };
  const response = await worker.fetch(new Request('https://gateway.test/v1/chat/completions', { method: 'POST', headers: { Authorization: 'Bearer secret-a', 'Content-Type': 'application/json' }, body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }) }), env);
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.equal(data.project, 'project-a');
  assert.equal(data.text, 'hello');
  assert.equal(data.provider, 'cloudflare');
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
