import Anthropic from '@anthropic-ai/sdk';
import { ProviderError, isAbortError } from '../../domain/errors';
import type { ChatMessage, FinishReason } from '../../domain/types';
import type { LlmProvider, ProviderRequest, ProviderResponse, ProviderStreamChunk } from '../../ports';
import { JSON_ONLY_INSTRUCTION } from './shared';

export interface AnthropicProviderOptions {
  apiKey: string;
  baseURL?: string;
}

export class AnthropicProvider implements LlmProvider {
  readonly id = 'anthropic' as const;
  private readonly client: Anthropic;

  constructor(opts: AnthropicProviderOptions) {
    // maxRetries 0: the gateway owns retries + breaker; SDK retries would multiply attempts.
    this.client = new Anthropic({ apiKey: opts.apiKey, baseURL: opts.baseURL, maxRetries: 0 });
  }

  async complete(req: ProviderRequest): Promise<ProviderResponse> {
    try {
      const msg = await this.client.messages.create(this.params(req), { signal: req.signal });
      let text = '';
      for (const block of msg.content) if (block.type === 'text') text += block.text;
      return {
        text,
        usage: { inputTokens: msg.usage.input_tokens, outputTokens: msg.usage.output_tokens },
        finishReason: mapStop(msg.stop_reason),
      };
    } catch (err) {
      throw toProviderError(err);
    }
  }

  async *stream(req: ProviderRequest): AsyncIterable<ProviderStreamChunk> {
    try {
      const stream = this.client.messages.stream(this.params(req), { signal: req.signal });
      for await (const event of stream) {
        if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
          yield { type: 'delta', text: event.delta.text };
        }
      }
      const final = await stream.finalMessage();
      yield {
        type: 'end',
        usage: { inputTokens: final.usage.input_tokens, outputTokens: final.usage.output_tokens },
        finishReason: mapStop(final.stop_reason),
      };
    } catch (err) {
      throw toProviderError(err);
    }
  }

  private params(req: ProviderRequest): Anthropic.MessageCreateParamsNonStreaming {
    const system = req.responseFormat === 'json' ? [req.system, JSON_ONLY_INSTRUCTION].filter(Boolean).join('\n\n') : req.system;
    // No temperature/top_p: as of the 2026-10-21 API change they are rejected on every model.
    // Thinking is left at the model default (adaptive); depth is steered via effort only.
    return {
      model: req.model,
      max_tokens: req.maxTokens,
      ...(system ? { system } : {}),
      messages: req.messages.map(toAnthropicMessage),
      ...(req.effort ? { output_config: { effort: req.effort } } : {}),
    };
  }
}

function toAnthropicMessage(m: ChatMessage): Anthropic.MessageParam {
  if (typeof m.content === 'string') return { role: m.role, content: m.content };
  return {
    role: m.role,
    content: m.content.map((p): Anthropic.ContentBlockParam =>
      p.type === 'text'
        ? { type: 'text', text: p.text }
        : { type: 'image', source: { type: 'base64', media_type: p.mediaType, data: p.data } },
    ),
  };
}

function mapStop(reason: Anthropic.Message['stop_reason']): FinishReason {
  switch (reason) {
    case 'end_turn':
    case 'stop_sequence':
      return 'stop';
    case 'max_tokens':
      return 'length';
    case 'refusal':
      return 'refusal';
    default:
      return 'other';
  }
}

function toProviderError(err: unknown): unknown {
  if (err instanceof ProviderError || isAbortError(err)) return err;
  if (err instanceof Anthropic.APIConnectionError) return new ProviderError('network', err.message);
  if (err instanceof Anthropic.APIError) return ProviderError.fromStatus(err.status, err.message);
  return err;
}
