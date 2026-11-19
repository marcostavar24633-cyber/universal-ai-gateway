# Universal AI Gateway

Standalone Cloudflare Worker exposing one authenticated chat API for multiple projects.

## Status

Deployed to Cloudflare Workers through the manual `Deploy Universal AI Gateway` GitHub Actions workflow. OpenRouter and direct OpenAI/Anthropic API providers are disabled by default. No secrets are included in this repository.

## API

- `GET /health`
- `POST /v1/chat/completions`

Example request body:

```json
{
  "provider": "cloudflare",
  "routeMode": "auto",
  "messages": [{ "role": "user", "content": "Hello" }]
}
```

Optional fields: `max_tokens`, `temperature` (forwarded to every provider except Anthropic, which only receives `max_tokens`), and `stream`.

Pass a project-specific token in `Authorization: Bearer <project-token>`.

### Streaming

With `"stream": true` the gateway answers with `text/event-stream` in the OpenAI `chat.completion.chunk` format, ending with `data: [DONE]`. The last chunk carries `finish_reason` and, when the provider reports it, `usage`. Project, provider and fallback details are returned in the `X-Gateway-Project`, `X-Gateway-Provider`, `X-Gateway-Fallback` and `X-Gateway-Fallback-Reason` headers. Quota errors happen before the first byte, so `auto` fallback works the same as without streaming; if the upstream stream breaks midway, the gateway sends an error event with code `STREAM_INTERRUPTED` and then `[DONE]`.

Set `GATEWAY_PROJECT_KEYS` as a Cloudflare Worker secret containing a JSON object mapping project IDs to long, unique random tokens. Never expose tokens or provider keys in browser code or commit them to Git.

## Request protection

The Worker applies a Cloudflare Rate Limiting binding after project authentication: 30 requests per 60-second window per project key. Cloudflare documents these limits as approximate and location-scoped, not strict global budgets; bursts can exceed the threshold while counters synchronize. This is a basic abuse guard, not a guaranteed daily AI-usage quota. Request bodies are capped at 32 KB and 40 messages.

## Routing

- `primary`: call only the selected provider.
- `auto`: call the selected provider; only detected quota/rate-limit errors trigger OpenRouter Free fallback.
- `openrouter`: call only the fixed `openrouter/free` route.
- Other provider failures do not silently switch routes.

Cloudflare Workers AI is the default. OpenRouter requires both `OPENROUTER_ENABLED=true` and the `OPENROUTER_API_KEY` secret. Direct OpenAI/Anthropic API access requires `AI_BILLING_MODE=api`, `AI_DIRECT_PROVIDERS_ENABLED=true`, and the corresponding server-side secret. Those APIs can incur separate charges and are disabled by default.

## Local validation

```sh
npm install
npm test
npm run dry-run
```

## Deploy

After authenticating Wrangler to the intended Cloudflare account and reviewing the configuration:

```sh
npm run deploy
npx wrangler secret put GATEWAY_PROJECT_KEYS
```

Alternatively, run the `Deploy Universal AI Gateway` workflow manually from GitHub Actions; it requires the `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` repository secrets. Only configure the OpenRouter key if intentionally enabling the free OpenRouter route.
