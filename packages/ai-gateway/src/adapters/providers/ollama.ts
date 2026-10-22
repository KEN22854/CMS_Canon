import { ProviderError, isAbortError } from '../../domain/errors';
import type { ChatMessage, FinishReason } from '../../domain/types';
import type { LlmProvider, ProviderRequest, ProviderResponse, ProviderStreamChunk } from '../../ports';

export interface OllamaProviderOptions {
  baseUrl: string;
}

interface OllamaChatResponse {
  message?: { content?: string };
  done?: boolean;
  done_reason?: string;
  prompt_eval_count?: number;
  eval_count?: number;
  error?: string;
}

/**
 * Local / self-hosted tier (Ollama, or vLLM behind an Ollama-compatible proxy). It is the last
 * real-model rung of the fallback chain, so it must work with zero external dependencies:
 * plain fetch against the documented REST API, no SDK.
 */
export class OllamaProvider implements LlmProvider {
  readonly id = 'ollama' as const;

  constructor(private readonly opts: OllamaProviderOptions) {}

  async complete(req: ProviderRequest): Promise<ProviderResponse> {
    const res = await this.post('/api/chat', this.body(req, false), req.signal);
    const json = (await res.json()) as OllamaChatResponse;
    if (json.error) throw new ProviderError('bad_request', json.error);
    return {
      text: json.message?.content ?? '',
      usage: { inputTokens: json.prompt_eval_count ?? 0, outputTokens: json.eval_count ?? 0 },
      finishReason: mapDone(json.done_reason),
    };
  }

  async *stream(req: ProviderRequest): AsyncIterable<ProviderStreamChunk> {
    const res = await this.post('/api/chat', this.body(req, true), req.signal);
    if (!res.body) throw new ProviderError('server', 'Ollama returned an empty stream');
    const decoder = new TextDecoder();
    let buffer = '';
    for await (const bytes of res.body as unknown as AsyncIterable<Uint8Array>) {
      buffer += decoder.decode(bytes, { stream: true });
      let nl: number;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        const chunk = JSON.parse(line) as OllamaChatResponse;
        if (chunk.error) throw new ProviderError('server', chunk.error);
        if (chunk.message?.content) yield { type: 'delta', text: chunk.message.content };
        if (chunk.done) {
          yield {
            type: 'end',
            usage: { inputTokens: chunk.prompt_eval_count ?? 0, outputTokens: chunk.eval_count ?? 0 },
            finishReason: mapDone(chunk.done_reason),
          };
        }
      }
    }
  }

  async embed(req: { model: string; input: string[]; signal: AbortSignal }): Promise<{ vectors: number[][]; inputTokens: number }> {
    const res = await this.post('/api/embed', { model: req.model, input: req.input }, req.signal);
    const json = (await res.json()) as { embeddings?: number[][]; prompt_eval_count?: number; error?: string };
    if (json.error) throw new ProviderError('bad_request', json.error);
    return { vectors: json.embeddings ?? [], inputTokens: json.prompt_eval_count ?? 0 };
  }

  private body(req: ProviderRequest, stream: boolean): object {
    const messages: { role: string; content: string; images?: string[] }[] = [];
    if (req.system) messages.push({ role: 'system', content: req.system });
    for (const m of req.messages) messages.push(toOllamaMessage(m));
    return {
      model: req.model,
      messages,
      stream,
      ...(req.responseFormat === 'json' ? { format: 'json' } : {}),
      options: { num_predict: req.maxTokens },
    };
  }

  private async post(path: string, body: object, signal: AbortSignal): Promise<Response> {
    let res: Response;
    try {
      res = await fetch(new URL(path, this.opts.baseUrl), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal,
      });
    } catch (err) {
      if (isAbortError(err)) throw err;
      throw new ProviderError('network', err instanceof Error ? err.message : String(err));
    }
    if (!res.ok) throw ProviderError.fromStatus(res.status, `Ollama ${path} → ${res.status} ${await res.text()}`);
    return res;
  }
}

function toOllamaMessage(m: ChatMessage): { role: string; content: string; images?: string[] } {
  if (typeof m.content === 'string') return { role: m.role, content: m.content };
  const text = m.content.map((p) => (p.type === 'text' ? p.text : '')).join('\n');
  const images = m.content.flatMap((p) => (p.type === 'image' ? [p.data] : []));
  return images.length > 0 ? { role: m.role, content: text, images } : { role: m.role, content: text };
}

function mapDone(reason: string | undefined): FinishReason {
  if (reason === 'stop') return 'stop';
  if (reason === 'length') return 'length';
  return 'other';
}
