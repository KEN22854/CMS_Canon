import { ApiError, GoogleGenAI, type Content, type GenerateContentParameters, type GenerateContentResponse } from '@google/genai';
import { ProviderError, isAbortError } from '../../domain/errors';
import type { ChatMessage, FinishReason, TokenUsage } from '../../domain/types';
import type { LlmProvider, ProviderRequest, ProviderResponse, ProviderStreamChunk } from '../../ports';

export interface GoogleProviderOptions {
  apiKey: string;
}

export class GoogleProvider implements LlmProvider {
  readonly id = 'google' as const;
  private readonly ai: GoogleGenAI;

  constructor(opts: GoogleProviderOptions) {
    this.ai = new GoogleGenAI({ apiKey: opts.apiKey });
  }

  async complete(req: ProviderRequest): Promise<ProviderResponse> {
    try {
      const res = await this.ai.models.generateContent(this.params(req));
      return { text: res.text ?? '', usage: usageOf(res), finishReason: mapFinish(res) };
    } catch (err) {
      throw toProviderError(err);
    }
  }

  async *stream(req: ProviderRequest): AsyncIterable<ProviderStreamChunk> {
    try {
      const stream = await this.ai.models.generateContentStream(this.params(req));
      let last: GenerateContentResponse | undefined;
      for await (const chunk of stream) {
        const text = chunk.text;
        if (text) yield { type: 'delta', text };
        last = chunk;
      }
      yield { type: 'end', usage: last ? usageOf(last) : { inputTokens: 0, outputTokens: 0 }, finishReason: last ? mapFinish(last) : 'other' };
    } catch (err) {
      throw toProviderError(err);
    }
  }

  async embed(req: { model: string; input: string[]; signal: AbortSignal }): Promise<{ vectors: number[][]; inputTokens: number }> {
    try {
      const res = await this.ai.models.embedContent({ model: req.model, contents: req.input, config: { abortSignal: req.signal } });
      const vectors = (res.embeddings ?? []).map((e) => e.values ?? []);
      // Gemini embeddings do not report token usage; estimate for cost accounting.
      const inputTokens = Math.ceil(req.input.reduce((n, t) => n + t.length, 0) / 4);
      return { vectors, inputTokens };
    } catch (err) {
      throw toProviderError(err);
    }
  }

  private params(req: ProviderRequest): GenerateContentParameters {
    return {
      model: req.model,
      contents: req.messages.map(toGeminiContent),
      config: {
        ...(req.system ? { systemInstruction: req.system } : {}),
        maxOutputTokens: req.maxTokens,
        ...(req.responseFormat === 'json' ? { responseMimeType: 'application/json' } : {}),
        abortSignal: req.signal,
      },
    };
  }
}

function toGeminiContent(m: ChatMessage): Content {
  const role = m.role === 'assistant' ? 'model' : 'user';
  if (typeof m.content === 'string') return { role, parts: [{ text: m.content }] };
  return {
    role,
    parts: m.content.map((p) => (p.type === 'text' ? { text: p.text } : { inlineData: { mimeType: p.mediaType, data: p.data } })),
  };
}

function usageOf(res: GenerateContentResponse): TokenUsage {
  return {
    inputTokens: res.usageMetadata?.promptTokenCount ?? 0,
    outputTokens: res.usageMetadata?.candidatesTokenCount ?? 0,
  };
}

function mapFinish(res: GenerateContentResponse): FinishReason {
  const reason = res.candidates?.[0]?.finishReason;
  switch (reason) {
    case 'STOP':
      return 'stop';
    case 'MAX_TOKENS':
      return 'length';
    case 'SAFETY':
    case 'PROHIBITED_CONTENT':
    case 'BLOCKLIST':
      return 'content_filter';
    default:
      return 'other';
  }
}

function toProviderError(err: unknown): unknown {
  if (err instanceof ProviderError || isAbortError(err)) return err;
  if (err instanceof ApiError) return ProviderError.fromStatus(err.status, err.message);
  if (err instanceof TypeError) return new ProviderError('network', err.message); // fetch failures
  return err;
}
