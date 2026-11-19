# Universal AI Gateway

Standalone Cloudflare Worker exposing one authenticated chat API for multiple projects.

## Status

Deployed to Cloudflare Workers through the manual `Deploy Universal AI Gateway` GitHub Actions workflow. OpenRouter and direct OpenAI/Anthropic API providers are disabled by default. No secrets are included in this repository.

## API

- `GET /health`
- `GET /v1/models` (requires a project token; lists only the routes configured for this Worker)
- `POST /v1/chat/completions`

The API is compatible with official OpenAI SDKs: point `baseURL` at `https://<worker>/v1` and use the project token as the API key. Routing is controlled by `provider` and `routeMode`. The `model` field is honored only for Workers AI and only as an `@cf/...` id (for example `@cf/google/gemma-4-26b-a4b-it`); other values, such as the `gpt-4o` default of OpenAI SDKs, are ignored. Fallback providers always use their own configured models.

Example request body:

```json
{
  "provider": "cloudflare",
  "routeMode": "auto",
  "messages": [{ "role": "user", "content": "Hello" }]
}
```

Optional fields: `max_tokens`, `temperature` (forwarded to every provider except Anthropic, which only receives `max_tokens`), `stream`, `response_format` (`{"type":"json_object"}` or a `json_schema`; Workers AI and OpenAI-compatible providers) and `chat_template_kwargs` (a flat object of up to 8 scalar values, Workers AI only, e.g. `{"enable_thinking": false}` for models whose chat template supports it).

Pass a project-specific token in `Authorization: Bearer <project-token>`.

### Streaming

With `"stream": true` the gateway answers with `text/event-stream` in the OpenAI `chat.completion.chunk` format, ending with `data: [DONE]`. The last chunk carries `finish_reason` and, when the provider reports it, `usage`. Project, provider and fallback details are returned in the `X-Gateway-Project`, `X-Gateway-Provider`, `X-Gateway-Fallback` and `X-Gateway-Fallback-Reason` headers. Quota errors happen before the first byte, so `auto` fallback works the same as without streaming; if the upstream stream breaks midway, the gateway sends an error event with code `STREAM_INTERRUPTED` and then `[DONE]`.

### Errors

Errors use the OpenAI shape `{"error": {"message", "type", "code"}}`. Stable codes include `INVALID_PROJECT_TOKEN`, `PROJECT_RATE_LIMIT`, `INVALID_MESSAGES`, `REQUEST_TOO_LARGE`, `PROVIDER_LIMIT` and `PROVIDER_UNAVAILABLE`.

Workers AI does not report why generation stopped, so the gateway returns `finish_reason: "length"` when the reply used the whole `max_tokens` budget (256 tokens by default on Workers AI).

Set `GATEWAY_PROJECT_KEYS` as a Cloudflare Worker secret containing a JSON object mapping project IDs to long, unique random tokens. Never expose tokens or provider keys in browser code or commit them to Git.

### Adding a project

Cloudflare secrets cannot be read back, so appending to `GATEWAY_PROJECT_KEYS` means rewriting every token. Instead, give each new project its own secret `PROJECT_KEY_<NAME>` (`PROJECT_KEY_MY_SITE` authenticates project `my-site`):

```sh
npm run add-project -- my-site
```

The script generates a random token, stores it with `wrangler secret put`, and copies it to the clipboard without printing it (`--print` shows it). No redeploy is needed. To revoke a project, delete its secret with `npx wrangler secret delete PROJECT_KEY_<NAME>`. If a name exists in both places, `GATEWAY_PROJECT_KEYS` wins.

## Request protection

The Worker applies a Cloudflare Rate Limiting binding after project authentication: 30 requests per 60-second window per project key. Cloudflare documents these limits as approximate and location-scoped, not strict global budgets; bursts can exceed the threshold while counters synchronize. This is a basic abuse guard, not a guaranteed daily AI-usage quota. Request bodies are capped at 128 KB, 40 messages and 48,000 characters per message.

## Routing

- `primary`: call only the selected provider.
- `auto`: call the selected provider; only detected quota/rate-limit errors on it start the fallback chain.
- `openrouter`: call only the fixed `openrouter/free` route.
- Other failures of the selected provider do not silently switch routes.

### Fallback chain

`FALLBACK_CHAIN` (in `wrangler.toml`) lists free-tier providers to try in order once the primary provider is out of quota: by default `groq,cerebras,gemini,mistral,openrouter`. A provider without its key is skipped; a provider that is itself out of quota or unavailable hands over to the next one. If every provider in the chain fails, the gateway returns `PROVIDER_LIMIT` (429) or `PROVIDER_UNAVAILABLE` (503). Paid providers (`openai`, `anthropic`) are never used as fallbacks. `PROJECT_FALLBACK_CHAINS` (a JSON object in `wrangler.toml`, e.g. `{"unique-design-studio":"groq"}`) overrides the chain for individual projects; an empty string disables fallback for that project. The override is configured on the gateway, so clients cannot widen it. The non-streaming response includes `fallbackAttempts`, the providers tried in order.

| Provider | Secret to set | Optional model variable (default) |
|---|---|---|
| `groq` | `GROQ_API_KEY` | `GROQ_MODEL` (`openai/gpt-oss-120b`) |
| `cerebras` | `CEREBRAS_API_KEY` | `CEREBRAS_MODEL` (`llama-3.3-70b`) |
| `gemini` | `GEMINI_API_KEY` | `GEMINI_MODEL` (`gemini-flash-latest`, an alias that follows the current Flash model) |
| `mistral` | `MISTRAL_API_KEY` | `MISTRAL_MODEL` (`mistral-small-latest`) |
| `openrouter` | `OPENROUTER_API_KEY` plus `OPENROUTER_ENABLED=true` | fixed `openrouter/free` |

Each provider gets 25 seconds to start responding (`PROVIDER_TIMEOUT_MS` overrides it); a provider that misses it counts as unavailable and the chain moves on.

Add a key with `npx wrangler secret put GROQ_API_KEY` (no redeploy needed). Free-tier models and limits change often; if a default model is retired, set the matching model variable. Any provider in the table can also be called directly with `"provider": "<name>", "routeMode": "primary"`.

Cloudflare Workers AI is the default. OpenRouter requires both `OPENROUTER_ENABLED=true` and the `OPENROUTER_API_KEY` secret. Direct OpenAI/Anthropic API access requires `AI_BILLING_MODE=api`, `AI_DIRECT_PROVIDERS_ENABLED=true`, and the corresponding server-side secret. Those APIs can incur separate charges and are disabled by default.

## Logs

Every chat request writes one JSON line (`"event":"gateway_request"`) with the project, requested and serving provider, model, fallback attempts, status or error code, token usage and duration. Message contents, project tokens and provider keys are never logged. Workers Logs is enabled in `wrangler.toml`, so the lines are searchable in the Cloudflare dashboard (Workers → universal-ai-gateway → Logs); `npx wrangler tail universal-ai-gateway` streams them live.

Dependabot opens weekly pull requests for npm and GitHub Actions updates.

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
