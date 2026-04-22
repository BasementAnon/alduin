import OpenAI from 'openai';
import { BaseProvider } from './base.js';
import { TokenCounter } from '../tokens/counter.js';
import type { ModelCatalog } from '../catalog/catalog.js';
import type {
  LLMCompletionRequest,
  LLMCompletionResponse,
  LLMError,
  LLMStreamChunk,
} from '../types/llm.js';
import { toOpenAITools, fromOpenAIToolCalls } from './compat.js';
import type { Result } from '../types/result.js';
import { ok, err } from '../types/result.js';

/**
 * OpenAI provider adapter.
 * Pricing comes from the catalog — no hardcoded constants.
 */
const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;

export class OpenAIProvider extends BaseProvider {
  readonly id: string = 'openai';
  protected client: OpenAI;
  private tokenCounter: TokenCounter;

  constructor(apiKey: string, catalog?: ModelCatalog, timeoutMs?: number) {
    super(catalog);
    this.client = new OpenAI({
      apiKey,
      timeout: timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
    });
    this.tokenCounter = new TokenCounter(catalog);
  }

  countTokens(text: string, model: string): number {
    return this.tokenCounter.countTokens(text, model);
  }

  async complete(
    request: LLMCompletionRequest
  ): Promise<Result<LLMCompletionResponse, LLMError>> {
    try {
      const modelName = request.model.includes('/')
        ? request.model.split('/').slice(1).join('/')
        : request.model;

      // Map to OpenAI's discriminated union — tool messages need explicit shaping
      const messages = request.messages.map((m) => {
        if (m.role === 'tool' && m.tool_call_id) {
          return { role: 'tool' as const, content: m.content, tool_call_id: m.tool_call_id };
        }
        return {
          role: m.role as 'system' | 'user' | 'assistant',
          content: m.content,
          ...(m.name ? { name: m.name } : {}),
        };
      }) as import('openai').OpenAI.ChatCompletionMessageParam[];

      const tools = request.tools ? toOpenAITools(request.tools) : undefined;

      const response = await this.client.chat.completions.create({
        model: modelName,
        messages,
        max_tokens: request.max_tokens,
        ...(request.temperature !== undefined
          ? { temperature: request.temperature }
          : {}),
        ...(request.stop_sequences ? { stop: request.stop_sequences } : {}),
        ...(request.response_format
          ? { response_format: request.response_format }
          : {}),
        ...(tools ? { tools } : {}),
      });

      const choice = response.choices[0];
      if (!choice) {
        return err(
          this.buildError('provider_error', 'No choices returned from OpenAI')
        );
      }

      const finishReasonMap: Record<string, LLMCompletionResponse['finish_reason']> = {
        stop: 'stop',
        length: 'max_tokens',
        tool_calls: 'tool_use',
        content_filter: 'stop',
      };

      // Extract tool calls
      const toolCalls = choice.message.tool_calls
        ? fromOpenAIToolCalls(
            choice.message.tool_calls as Array<{
              id: string;
              type: 'function';
              function: { name: string; arguments: string };
            }>
          )
        : undefined;

      return ok({
        content: choice.message.content ?? '',
        tool_calls: toolCalls,
        usage: {
          input_tokens: response.usage?.prompt_tokens ?? 0,
          output_tokens: response.usage?.completion_tokens ?? 0,
        },
        model: response.model,
        finish_reason:
          finishReasonMap[choice.finish_reason ?? 'stop'] ?? 'stop',
      });
    } catch (error) {
      return err(this.mapError(error));
    }
  }

  async *streamComplete(
    request: LLMCompletionRequest
  ): AsyncIterable<LLMStreamChunk> {
    const modelName = request.model.includes('/')
      ? request.model.split('/').slice(1).join('/')
      : request.model;

    const messages = request.messages.map((m) => {
      if (m.role === 'tool' && m.tool_call_id) {
        return { role: 'tool' as const, content: m.content, tool_call_id: m.tool_call_id };
      }
      return {
        role: m.role as 'system' | 'user' | 'assistant',
        content: m.content,
        ...(m.name ? { name: m.name } : {}),
      };
    }) as import('openai').OpenAI.ChatCompletionMessageParam[];

    const stream = await this.client.chat.completions.create({
      model: modelName,
      messages,
      max_tokens: request.max_tokens,
      stream: true,
      stream_options: { include_usage: true },
      ...(request.temperature !== undefined
        ? { temperature: request.temperature }
        : {}),
      ...(request.stop_sequences ? { stop: request.stop_sequences } : {}),
      ...(request.response_format
        ? { response_format: request.response_format }
        : {}),
    });

    const finishReasonMap: Record<string, LLMCompletionResponse['finish_reason']> = {
      stop: 'stop',
      length: 'max_tokens',
      tool_calls: 'tool_use',
      content_filter: 'stop',
    };

    for await (const chunk of stream) {
      const choice = chunk.choices[0];

      if (choice?.delta?.content) {
        yield { type: 'delta', content: choice.delta.content };
      }

      // Tool call streaming
      if (choice?.delta?.tool_calls) {
        for (const tc of choice.delta.tool_calls) {
          if (tc.id && tc.function?.name) {
            yield { type: 'tool_call_start', id: tc.id, name: tc.function.name };
          }
          if (tc.function?.arguments) {
            yield {
              type: 'tool_call_delta',
              id: tc.id ?? '',
              arguments_delta: tc.function.arguments,
            };
          }
        }
      }

      // Usage chunk (sent when stream_options.include_usage = true)
      if (chunk.usage) {
        yield {
          type: 'usage',
          usage: {
            input_tokens: chunk.usage.prompt_tokens ?? 0,
            output_tokens: chunk.usage.completion_tokens ?? 0,
          },
        };
      }

      // Finish reason
      if (choice?.finish_reason) {
        yield {
          type: 'finish',
          finish_reason: finishReasonMap[choice.finish_reason] ?? 'stop',
          usage: chunk.usage
            ? {
                input_tokens: chunk.usage.prompt_tokens ?? 0,
                output_tokens: chunk.usage.completion_tokens ?? 0,
              }
            : undefined,
        };
      }
    }
  }

  protected mapError(error: unknown): LLMError {
    if (error instanceof OpenAI.APIError) {
      if (error.status === 429) {
        const retryAfterHeader = (error.headers as Record<string, string> | undefined)?.[
          'retry-after'
        ];
        const retryAfterMs = retryAfterHeader
          ? parseInt(retryAfterHeader, 10) * 1000
          : undefined;
        return this.buildError('rate_limit', error.message, {
          retryable: true,
          retry_after_ms: retryAfterMs,
          status_code: 429,
        });
      }
      if (error.status === 401) {
        return this.buildError('auth', error.message, { status_code: 401 });
      }
      if (error.status === 400 && error.message.toLowerCase().includes('context')) {
        return this.buildError('context_overflow', error.message, { status_code: 400 });
      }
      return this.buildError('provider_error', error.message, {
        status_code: error.status,
      });
    }
    if (error instanceof Error && error.name === 'AbortError') {
      return this.buildError('timeout', error.message, { retryable: true });
    }
    return this.buildError(
      'provider_error',
      error instanceof Error ? error.message : String(error)
    );
  }
}
