import Anthropic from '@anthropic-ai/sdk';
import { BaseProvider } from './base.js';
import { TokenCounter } from '../tokens/counter.js';
import type { ModelCatalog } from '../catalog/catalog.js';
import type {
  LLMCompletionRequest,
  LLMCompletionResponse,
  LLMError,
  LLMMessage,
  LLMStreamChunk,
  LLMToolCall,
} from '../types/llm.js';
import { toAnthropicTools, fromAnthropicToolUse } from './compat.js';
import type { Result } from '../types/result.js';
import { ok, err } from '../types/result.js';

/**
 * Anthropic Claude provider adapter.
 * Separates system messages from the conversation per Anthropic's API contract.
 * Pricing comes from the catalog — no hardcoded constants.
 */
const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;

export class AnthropicProvider extends BaseProvider {
  readonly id = 'anthropic';
  private client: Anthropic;
  private tokenCounter: TokenCounter;

  constructor(apiKey: string, catalog?: ModelCatalog, timeoutMs?: number) {
    super(catalog);
    this.client = new Anthropic({
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
      const systemMessages = request.messages
        .filter((m): m is LLMMessage & { role: 'system' } => m.role === 'system')
        .map((m) => m.content)
        .join('\n');

      const conversationMessages = request.messages.filter(
        (m) => m.role !== 'system'
      );

      const anthropicMessages = conversationMessages.map((m) => ({
        role: m.role as 'user' | 'assistant',
        content: m.content,
      }));

      const modelName = request.model.includes('/')
        ? request.model.split('/').slice(1).join('/')
        : request.model;

      const tools = request.tools ? toAnthropicTools(request.tools) : undefined;

      const response = await this.client.messages.create({
        model: modelName,
        max_tokens: request.max_tokens,
        ...(systemMessages ? { system: systemMessages } : {}),
        messages: anthropicMessages,
        ...(request.temperature !== undefined
          ? { temperature: request.temperature }
          : {}),
        ...(request.stop_sequences ? { stop_sequences: request.stop_sequences } : {}),
        ...(tools ? { tools } : {}),
      });

      const content = response.content
        .filter((block) => block.type === 'text')
        .map((block) => (block as { type: 'text'; text: string }).text)
        .join('');

      // Extract tool calls from tool_use content blocks
      const toolCalls: LLMToolCall[] = response.content
        .filter((block) => block.type === 'tool_use')
        .map((block) =>
          fromAnthropicToolUse(
            block as { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
          )
        );

      const finishReasonMap: Record<string, LLMCompletionResponse['finish_reason']> = {
        end_turn: 'stop',
        max_tokens: 'max_tokens',
        tool_use: 'tool_use',
        stop_sequence: 'stop',
      };

      return ok({
        content,
        tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
        usage: {
          input_tokens: response.usage.input_tokens,
          output_tokens: response.usage.output_tokens,
        },
        model: response.model,
        finish_reason: finishReasonMap[response.stop_reason ?? 'end_turn'] ?? 'stop',
      });
    } catch (error) {
      return err(this.mapError(error));
    }
  }

  async *streamComplete(
    request: LLMCompletionRequest
  ): AsyncIterable<LLMStreamChunk> {
    const systemMessages = request.messages
      .filter((m): m is LLMMessage & { role: 'system' } => m.role === 'system')
      .map((m) => m.content)
      .join('\n');

    const conversationMessages = request.messages.filter(
      (m) => m.role !== 'system'
    );

    const anthropicMessages = conversationMessages.map((m) => ({
      role: m.role as 'user' | 'assistant',
      content: m.content,
    }));

    const modelName = request.model.includes('/')
      ? request.model.split('/').slice(1).join('/')
      : request.model;

    const stream = this.client.messages.stream({
      model: modelName,
      max_tokens: request.max_tokens,
      ...(systemMessages ? { system: systemMessages } : {}),
      messages: anthropicMessages,
      ...(request.temperature !== undefined
        ? { temperature: request.temperature }
        : {}),
      ...(request.stop_sequences ? { stop_sequences: request.stop_sequences } : {}),
    });

    const finishReasonMap: Record<string, import('../types/llm.js').LLMCompletionResponse['finish_reason']> = {
      end_turn: 'stop',
      max_tokens: 'max_tokens',
      tool_use: 'tool_use',
      stop_sequence: 'stop',
    };

    for await (const event of stream) {
      if (event.type === 'content_block_delta') {
        const delta = event.delta as { type: string; text?: string; partial_json?: string };
        if (delta.type === 'text_delta' && delta.text) {
          yield { type: 'delta', content: delta.text };
        }
        if (delta.type === 'input_json_delta' && delta.partial_json) {
          // Tool call argument streaming
          yield { type: 'tool_call_delta', id: '', arguments_delta: delta.partial_json };
        }
      }

      if (event.type === 'content_block_start') {
        const block = (event as { content_block?: { type: string; id?: string; name?: string } }).content_block;
        if (block?.type === 'tool_use' && block.id && block.name) {
          yield { type: 'tool_call_start', id: block.id, name: block.name };
        }
      }

      if (event.type === 'message_delta') {
        const msgDelta = event as { usage?: { output_tokens?: number }; delta?: { stop_reason?: string } };
        if (msgDelta.usage?.output_tokens !== undefined) {
          yield {
            type: 'usage',
            usage: { input_tokens: 0, output_tokens: msgDelta.usage.output_tokens },
          };
        }
      }

      if (event.type === 'message_stop') {
        // Final message with full usage
        const finalMessage = await stream.finalMessage();
        const finishReason = finishReasonMap[finalMessage.stop_reason ?? 'end_turn'] ?? 'stop';
        yield {
          type: 'finish',
          finish_reason: finishReason,
          usage: {
            input_tokens: finalMessage.usage.input_tokens,
            output_tokens: finalMessage.usage.output_tokens,
          },
        };
      }
    }
  }

  private mapError(error: unknown): LLMError {
    if (error instanceof Anthropic.APIError) {
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
