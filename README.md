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

Pass a project-specific token in `Authorization: Bearer <project-token>`.

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
