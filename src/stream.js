// Server-sent events helpers: parse upstream provider streams into a common
// event shape ({ text?, finishReason?, usage? }) and re-emit them as
// OpenAI-compatible `chat.completion.chunk` SSE.

const OPENAI_FINISH_REASONS = new Set(['stop', 'length', 'content_filter', 'tool_calls']);
const ANTHROPIC_FINISH_REASONS = { end_turn: 'stop', stop_sequence: 'stop', max_tokens: 'length', refusal: 'content_filter' };

export function mapOpenAIFinishReason(reason) {
  return OPENAI_FINISH_REASONS.has(reason) ? reason : 'stop';
}

export function mapAnthropicFinishReason(reason) {
  return ANTHROPIC_FINISH_REASONS[reason] || 'stop';
}

export function toOpenAIUsage(usage) {
  const prompt = Number(usage?.prompt_tokens);
  const completion = Number(usage?.completion_tokens);
  if (!Number.isFinite(prompt) || !Number.isFinite(completion)) return undefined;
  return { prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion };
}

// Yields the payload of each `data:` line from an SSE byte stream.
export async function* readSSEData(body) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      const lines = buffer.split(/\r?\n/);
      buffer = done ? '' : lines.pop();
      for (const line of lines) {
        if (line.startsWith('data:')) yield line.slice(5).trimStart();
      }
      if (done) return;
    }
  } finally {
    reader.releaseLock();
  }
}

function parseJSON(data) {
  try { return JSON.parse(data); } catch { return null; }
}

// OpenAI and OpenRouter chat completion chunks.
export async function* openAIStreamEvents(body) {
  for await (const data of readSSEData(body)) {
    if (data === '[DONE]') return;
    const chunk = parseJSON(data);
    if (!chunk) continue;
    if (chunk.error) throw new Error('Upstream stream reported an error');
    const choice = chunk.choices?.[0];
    yield {
      text: typeof choice?.delta?.content === 'string' ? choice.delta.content : undefined,
      finishReason: choice?.finish_reason ? mapOpenAIFinishReason(choice.finish_reason) : undefined,
      usage: toOpenAIUsage(chunk.usage),
    };
  }
}

// Workers AI text generation stream: `data: {"response":"..."}` ... `data: [DONE]`.
export async function* cloudflareStreamEvents(body) {
  for await (const data of readSSEData(body)) {
    if (data === '[DONE]') return;
    const chunk = parseJSON(data);
    if (!chunk) continue;
    yield {
      text: typeof chunk.response === 'string' && chunk.response.length ? chunk.response : undefined,
      usage: toOpenAIUsage(chunk.usage),
    };
  }
}

// Anthropic Messages API stream events.
export async function* anthropicStreamEvents(body) {
  let promptTokens;
  for await (const data of readSSEData(body)) {
    const event = parseJSON(data);
    if (!event) continue;
    if (event.type === 'error') throw new Error('Upstream stream reported an error');
    if (event.type === 'message_start') promptTokens = event.message?.usage?.input_tokens;
    if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') yield { text: event.delta.text };
    if (event.type === 'message_delta') {
      yield {
        finishReason: event.delta?.stop_reason ? mapAnthropicFinishReason(event.delta.stop_reason) : undefined,
        usage: toOpenAIUsage({ prompt_tokens: promptTokens, completion_tokens: event.usage?.output_tokens }),
      };
    }
    if (event.type === 'message_stop') return;
  }
}

// Re-emits normalized events as OpenAI-compatible SSE, ending with `data: [DONE]`.
export function toOpenAISSE({ id, created, model, events }) {
  const encoder = new TextEncoder();
  const iterator = events[Symbol.asyncIterator]();
  const send = (controller, payload) => controller.enqueue(encoder.encode(`data: ${typeof payload === 'string' ? payload : JSON.stringify(payload)}\n\n`));
  const chunk = (delta, finishReason = null, extra = {}) => ({
    id, object: 'chat.completion.chunk', created, model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
    ...extra,
  });
  let finishReason = 'stop';
  let usage;
  let started = false;

  return new ReadableStream({
    async pull(controller) {
      if (!started) {
        started = true;
        send(controller, chunk({ role: 'assistant' }));
        return;
      }
      try {
        // Keep reading until something is enqueued: returning from pull() without
        // enqueuing can leave a pending reader waiting forever.
        while (true) {
          const { done, value } = await iterator.next();
          if (done) {
            send(controller, chunk({}, finishReason, usage ? { usage } : {}));
            send(controller, '[DONE]');
            controller.close();
            return;
          }
          if (value.finishReason) finishReason = value.finishReason;
          if (value.usage) usage = value.usage;
          if (value.text) {
            send(controller, chunk({ content: value.text }));
            return;
          }
        }
      } catch {
        send(controller, { error: { message: 'Upstream stream interrupted', code: 'STREAM_INTERRUPTED' } });
        send(controller, '[DONE]');
        controller.close();
      }
    },
    async cancel() {
      await iterator.return?.();
    },
  });
}
