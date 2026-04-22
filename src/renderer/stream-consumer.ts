/**
 * Stream consumer — bridges LLM streaming output to the renderer subscriber.
 *
 * Consumes an AsyncIterable<LLMStreamChunk> and emits throttled partial
 * updates via a callback. The throttle (default 1.5s) prevents channels
 * from DDoS-ing themselves when Ollama streams character-by-character.
 *
 * Budget integration: usage chunks flow through the budget guard
 * incrementally so a runaway stream trips the budget early.
 */

import type { LLMStreamChunk, LLMUsage, LLMCompletionResponse } from '../types/llm.js';
import type { LLMToolCall } from '../types/llm.js';

/** Callbacks the consumer invokes during streaming */
export interface StreamConsumerCallbacks {
  /** Called with accumulated text at the throttle interval */
  onPartial(text: string): void;
  /** Called with each usage update (for incremental budget tracking) */
  onUsage(usage: LLMUsage): void;
  /** Called when a tool call starts */
  onToolCallStart?(id: string, name: string): void;
  /** Called when a tool call argument chunk arrives */
  onToolCallDelta?(id: string, argumentsDelta: string): void;
}

/** Result of consuming a full stream */
export interface StreamConsumeResult {
  /** Full accumulated text content */
  content: string;
  /** Final usage (from the finish chunk, or accumulated) */
  usage: LLMUsage;
  /** Finish reason */
  finish_reason: LLMCompletionResponse['finish_reason'];
  /** Assembled tool calls (if any) */
  tool_calls: LLMToolCall[];
  /** Whether the stream was aborted (e.g. by budget) */
  aborted: boolean;
}

/**
 * Consume a streaming response, throttling partial updates.
 *
 * @param stream       The provider's streaming output
 * @param callbacks    Callbacks for partial updates and usage
 * @param throttleMs   Minimum interval between onPartial calls (default 1500ms)
 * @param shouldAbort  Optional function checked each chunk — return true to abort
 */
export async function consumeStream(
  stream: AsyncIterable<LLMStreamChunk>,
  callbacks: StreamConsumerCallbacks,
  throttleMs = 1500,
  shouldAbort?: () => boolean
): Promise<StreamConsumeResult> {
  let content = '';
  let lastPartialAt = 0;
  let finalUsage: LLMUsage = { input_tokens: 0, output_tokens: 0 };
  let finishReason: LLMCompletionResponse['finish_reason'] = 'stop';
  let aborted = false;

  // Tool call assembly
  const toolCallMap = new Map<string, { id: string; name: string; arguments: string }>();

  for await (const chunk of stream) {
    // Check abort condition (e.g. budget exceeded)
    if (shouldAbort?.()) {
      aborted = true;
      break;
    }

    switch (chunk.type) {
      case 'delta':
        content += chunk.content;
        // Throttled partial delivery
        if (Date.now() - lastPartialAt >= throttleMs) {
          callbacks.onPartial(content);
          lastPartialAt = Date.now();
        }
        break;

      case 'tool_call_start':
        toolCallMap.set(chunk.id, { id: chunk.id, name: chunk.name, arguments: '' });
        callbacks.onToolCallStart?.(chunk.id, chunk.name);
        break;

      case 'tool_call_delta': {
        const tc = toolCallMap.get(chunk.id);
        if (tc) {
          tc.arguments += chunk.arguments_delta;
        }
        callbacks.onToolCallDelta?.(chunk.id, chunk.arguments_delta);
        break;
      }

      case 'usage':
        finalUsage = chunk.usage;
        callbacks.onUsage(chunk.usage);
        break;

      case 'finish':
        finishReason = chunk.finish_reason;
        if (chunk.usage) {
          finalUsage = chunk.usage;
          callbacks.onUsage(chunk.usage);
        }
        break;
    }
  }

  // Final partial flush (if there's unsent content)
  if (content && Date.now() - lastPartialAt > 0) {
    callbacks.onPartial(content);
  }

  // Assemble tool calls
  const tool_calls: LLMToolCall[] = [];
  for (const tc of toolCallMap.values()) {
    let parsedArgs: Record<string, unknown> = {};
    try {
      parsedArgs = JSON.parse(tc.arguments) as Record<string, unknown>;
    } catch {
      // If arguments aren't valid JSON, pass as raw string
      parsedArgs = { _raw: tc.arguments };
    }
    tool_calls.push({ id: tc.id, name: tc.name, arguments: parsedArgs });
  }

  return {
    content,
    usage: finalUsage,
    finish_reason: finishReason,
    tool_calls,
    aborted,
  };
}
