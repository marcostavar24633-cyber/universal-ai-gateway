# Universal AI Gateway

A standalone, free-first AI routing gateway for multiple applications.

The implementation is being introduced via pull request. See the project documentation and deployment instructions once the foundation PR is opened.

## Safety defaults

- Cloudflare Workers AI is the default provider.
- OpenRouter Free fallback is disabled until explicitly configured.
- Direct OpenAI and Anthropic API providers are disabled unless explicitly opted into API billing.
- Provider keys and project tokens must be stored as Cloudflare Worker secrets, never in source control.
- No paid route should ever be enabled implicitly.
