import { BaseProvider } from './base.js';
import { TokenCounter } from '../tokens/counter.js';
import type { ModelCatalog } from '../catalog/catalog.js';
import type {
  LLMCompletionRequest,
  LLMCompletionResponse,
  LLMError,
  LLMUsage,
  LLMStreamChunk,
} from '../types/llm.js';
import {
  buildOllamaToolPrompt,
  parseOllamaToolResponse,
} from './compat.js';
import type { Result } from '../types/result.js';
import { ok, err } from '../types/result.js';

interface OllamaMessage {
  role: string;
  content: string;
}

interface OllamaResponse {
  model: string;
  message: OllamaMessage;
  done: boolean;
  done_reason?: string;
  prompt_eval_count?: number;
  eval_count?: number;
}

interface OllamaStreamChunk {
  model: string;
  message: OllamaMessage;
  done: boolean;
  done_reason?: string;
  prompt_eval_count?: number;
  eval_count?: number;
}

/**
 * Ollama local provider adapter.
 * Uses the Ollama REST API directly via fetch (no SDK required).
 * estimateCost() always returns 0 — local inference is free.
 */
export class OllamaProvider extends BaseProvider {
  readonly id = 'ollama';
  private baseUrl: string;
  private tokenCounter: TokenCounter;

  constructor(baseUrl = 'http://localhost:11434', catalog?: ModelCatalog) {
    super(catalog);
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.tokenCounter = new TokenCounter(catalog);
  }

  countTokens(text: string, model: string): number {
    return this.tokenCounter.countTokens(text, model);
  }

  /** Local models are free — always returns 0 */
  override estimateCost(_model: string, _usage: LLMUsage): number {
    return 0;
  }

  async complete(
    request: LLMCompletionRequest
  ): Promise<Result<LLMCompletionResponse, LLMError>> {
    const modelName = request.model.includes('/')
      ? request.model.split('/').slice(1).join('/')
      : request.model;

    // If tools are provided, inject the tool prompt as a system suffix
    const toolPrompt = request.tools && request.tools.length > 0
      ? buildOllamaToolPrompt(request.tools)
      : null;

    const messages = request.messages.map((m) => {
      if (m.role === 'system' && toolPrompt) {
        return { role: m.role, content: m.content + '\n\n' + toolPrompt };
      }
      return { role: m.role, content: m.content };
    });

    // If no system message but tools are present, add one
    if (toolPrompt && !request.messages.some((m) => m.role === 'system')) {
      messages.unshift({ role: 'system', content: toolPrompt });
    }

    try {
      const response = await fetch(`${this.baseUrl}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: modelName,
          messages,
          stream: false,
          options: {
            ...(request.temperature !== undefined
              ? { temperature: request.temperature }
              : {}),
            num_predict: request.max_tokens,
          },
        }),
      });

      if (!response.ok) {
        const text = await response.text().catch(() => 'unknown error');
        return err(
          this.buildError('provider_error', `Ollama API error ${response.status}: ${text}`, {
            status_code: response.status,
          })
        );
      }

      const data = (await response.json()) as OllamaResponse;

      const finishReasonMap: Record<string, LLMCompletionResponse['finish_reason']> = {
        stop: 'stop',
        length: 'max_tokens',
      };

      // Try to extract tool calls from prompted JSON format
      const toolCalls = toolPrompt
        ? parseOllamaToolResponse(data.message.content)
        : null;

      return ok({
        content: toolCalls ? '' : data.message.content,
        tool_calls: toolCalls ?? undefined,
        usage: {
          input_tokens: data.prompt_eval_count ?? 0,
          output_tokens: data.eval_count ?? 0,
        },
        model: data.model,
        finish_reason: toolCalls ? 'tool_use' : (finishReasonMap[data.done_reason ?? 'stop'] ?? 'stop'),
      });
    } catch (error) {
      if (error instanceof TypeError && error.message.includes('fetch')) {
        return err(
          this.buildError('provider_error', 'Ollama not running', { retryable: false })
        );
      }
      if (error instanceof Error && error.message.includes('ECONNREFUSED')) {
        return err(
          this.buildError('provider_error', 'Ollama not running', { retryable: false })
        );
      }
      return err(
        this.buildError(
          'provider_error',
          error instanceof Error ? error.message : String(error)
        )
      );
    }
  }

  async *streamComplete(
    request: LLMCompletionRequest
  ): AsyncIterable<LLMStreamChunk> {
    const modelName = request.model.includes('/')
      ? request.model.split('/').slice(1).join('/')
      : request.model;

    const messages = request.messages.map((m) => ({
      role: m.role,
      content: m.content,
    }));

    const response = await fetch(`${this.baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: modelName,
        messages,
        stream: true,
        options: {
          ...(request.temperature !== undefined
            ? { temperature: request.temperature }
            : {}),
          num_predict: request.max_tokens,
        },
      }),
    });

    if (!response.ok || !response.body) {
      const text = await response.text().catch(() => 'unknown error');
      throw new Error(`Ollama API error ${response.status}: ${text}`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    const finishReasonMap: Record<string, LLMCompletionResponse['finish_reason']> = {
      stop: 'stop',
      length: 'max_tokens',
    };

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          if (!line.trim()) continue;
          let chunk: OllamaStreamChunk;
          try {
            chunk = JSON.parse(line) as OllamaStreamChunk;
          } catch {
            continue;
          }

          if (!chunk.done && chunk.message?.content) {
            yield { type: 'delta', content: chunk.message.content };
          }

          if (chunk.done) {
            const usage = {
              input_tokens: chunk.prompt_eval_count ?? 0,
              output_tokens: chunk.eval_count ?? 0,
            };
            yield { type: 'usage', usage };
            yield {
              type: 'finish',
              finish_reason: finishReasonMap[chunk.done_reason ?? 'stop'] ?? 'stop',
              usage,
            };
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  }
}
