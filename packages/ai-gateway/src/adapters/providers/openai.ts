import OpenAI from 'openai';
import { ProviderError, isAbortError } from '../../domain/errors';
import type { ChatMessage, FinishReason } from '../../domain/types';
import type { LlmProvider, ProviderRequest, ProviderResponse, ProviderStreamChunk } from '../../ports';
import { dataUrl } from './shared';

export interface OpenAiProviderOptions {
  apiKey: string;
  baseURL?: string;
}

type ChatParams = OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming;
type ChatMessageParam = OpenAI.Chat.Completions.ChatCompletionMessageParam;

export class OpenAiProvider implements LlmProvider {
  readonly id = 'openai' as const;
  private readonly client: OpenAI;

  constructor(opts: OpenAiProviderOptions) {
    this.client = new OpenAI({ apiKey: opts.apiKey, baseURL: opts.baseURL, maxRetries: 0 });
  }

  async complete(req: ProviderRequest): Promise<ProviderResponse> {
    try {
      const res = await this.client.chat.completions.create(this.params(req), { signal: req.signal });
      const choice = res.choices[0];
      return {
        text: choice?.message.content ?? '',
        usage: { inputTokens: res.usage?.prompt_tokens ?? 0, outputTokens: res.usage?.completion_tokens ?? 0 },
        finishReason: mapFinish(choice?.finish_reason),
      };
    } catch (err) {
      throw toProviderError(err);
    }
  }

  async *stream(req: ProviderRequest): AsyncIterable<ProviderStreamChunk> {
    try {
      const stream = await this.client.chat.completions.create(
        { ...this.params(req), stream: true, stream_options: { include_usage: true } },
        { signal: req.signal },
      );
      let finish: FinishReason = 'other';
      let usage = { inputTokens: 0, outputTokens: 0 };
      for await (const chunk of stream) {
        const choice = chunk.choices[0];
        const delta = choice?.delta?.content;
        if (delta) yield { type: 'delta', text: delta };
        if (choice?.finish_reason) finish = mapFinish(choice.finish_reason);
        // Usage arrives on a final chunk with empty `choices` when include_usage is set.
        if (chunk.usage) usage = { inputTokens: chunk.usage.prompt_tokens, outputTokens: chunk.usage.completion_tokens };
      }
      yield { type: 'end', usage, finishReason: finish };
    } catch (err) {
      throw toProviderError(err);
    }
  }

  async embed(req: { model: string; input: string[]; signal: AbortSignal }): Promise<{ vectors: number[][]; inputTokens: number }> {
    try {
      const res = await this.client.embeddings.create({ model: req.model, input: req.input }, { signal: req.signal });
      return { vectors: res.data.map((d) => d.embedding), inputTokens: res.usage.prompt_tokens };
    } catch (err) {
      throw toProviderError(err);
    }
  }

  private params(req: ProviderRequest): ChatParams {
    const messages: ChatMessageParam[] = [];
    if (req.system) messages.push({ role: 'system', content: req.system });
    for (const m of req.messages) messages.push(toOpenAiMessage(m));
    return {
      model: req.model,
      messages,
      max_completion_tokens: req.maxTokens,
      ...(req.responseFormat === 'json' ? { response_format: { type: 'json_object' as const } } : {}),
    };
  }
}

function toOpenAiMessage(m: ChatMessage): ChatMessageParam {
  if (m.role === 'assistant') {
    const text = typeof m.content === 'string' ? m.content : m.content.map((p) => (p.type === 'text' ? p.text : '')).join('');
    return { role: 'assistant', content: text };
  }
  if (typeof m.content === 'string') return { role: 'user', content: m.content };
  return {
    role: 'user',
    content: m.content.map((p): OpenAI.Chat.Completions.ChatCompletionContentPart =>
      p.type === 'text' ? { type: 'text', text: p.text } : { type: 'image_url', image_url: { url: dataUrl(p.mediaType, p.data) } },
    ),
  };
}

function mapFinish(reason: string | null | undefined): FinishReason {
  switch (reason) {
    case 'stop':
      return 'stop';
    case 'length':
      return 'length';
    case 'content_filter':
      return 'content_filter';
    default:
      return 'other';
  }
}

function toProviderError(err: unknown): unknown {
  if (err instanceof ProviderError || isAbortError(err)) return err;
  if (err instanceof OpenAI.APIConnectionError) return new ProviderError('network', err.message);
  if (err instanceof OpenAI.APIError) return ProviderError.fromStatus(err.status, err.message);
  return err;
}
