/**
 * Core LLM types — provider-agnostic contract between the orchestrator and all providers.
 * No Anthropic or OpenAI specific fields leak into these types.
 */

/** Roles in a conversation */
export type MessageRole = 'system' | 'user' | 'assistant' | 'tool';

/** A single message in a conversation */
export interface LLMMessage {
  role: MessageRole;
  content: string;
  /** For tool result messages — the ID of the tool call this responds to */
  tool_call_id?: string;
  /** For tool result messages — the tool name */
  name?: string;
}

/** Tool parameter definition */
export interface ToolParameter {
  type: string;
  description?: string;
  enum?: string[];
  properties?: Record<string, ToolParameter>;
  required?: string[];
  items?: ToolParameter;
}

/** A tool the model can call */
export interface LLMTool {
  name: string;
  description: string;
  parameters: ToolParameter;
}

/** A tool call made by the model */
export interface LLMToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

/** Request to an LLM provider */
export interface LLMCompletionRequest {
  model: string;
  messages: LLMMessage[];
  max_tokens: number;
  temperature?: number;
  tools?: LLMTool[];
  stop_sequences?: string[];
  /** Response format constraint */
  response_format?: { type: 'json_object' | 'text' };
}

/** Token usage from a completion */
export interface LLMUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens?: number;
  cache_write_tokens?: number;
}

/** Response from an LLM provider */
export interface LLMCompletionResponse {
  content: string;
  tool_calls?: LLMToolCall[];
  usage: LLMUsage;
  model: string;
  finish_reason: 'stop' | 'max_tokens' | 'tool_use' | 'error';
}

/** Error types from LLM providers */
export type LLMErrorType =
  | 'rate_limit'
  | 'auth'
  | 'context_overflow'
  | 'timeout'
  | 'invalid_request'
  | 'provider_error';

/** Structured error from an LLM call */
export interface LLMError {
  type: LLMErrorType;
  message: string;
  retryable: boolean;
  retry_after_ms?: number;
  provider?: string;
  status_code?: number;
}

/** Model pricing (USD per 1M tokens) */
export interface ModelPricing {
  input: number;
  output: number;
  cache_read?: number;
  cache_write?: number;
}

/** The interface every provider adapter must implement */
export interface LLMProvider {
  /** Provider identifier (e.g., 'anthropic', 'openai', 'ollama') */
  readonly id: string;

  /** Complete a chat conversation */
  complete(
    request: LLMCompletionRequest
  ): Promise<import('./result.js').Result<LLMCompletionResponse, LLMError>>;

  /** Stream a chat conversation, yielding chunks as they arrive */
  streamComplete(
    request: LLMCompletionRequest
  ): AsyncIterable<LLMStreamChunk>;

  /** Count tokens in a text string for this provider's models */
  countTokens(text: string, model?: string): number;

  /** Estimate cost in USD for a given usage */
  estimateCost(model: string, usage: LLMUsage): number;
}

// ── Streaming types ──────────────────────────────────────────────────────────

/**
 * A chunk emitted during streaming completion.
 * Discriminated union on `type`.
 */
export type LLMStreamChunk =
  | { type: 'delta'; content: string }
  | { type: 'tool_call_start'; id: string; name: string }
  | { type: 'tool_call_delta'; id: string; arguments_delta: string }
  | { type: 'usage'; usage: LLMUsage }
  | { type: 'finish'; finish_reason: LLMCompletionResponse['finish_reason']; usage?: LLMUsage };

/** A conversation turn for history tracking */
export interface ConversationTurn {
  role: 'user' | 'assistant';
  content: string;
  timestamp: Date;
  /** Compressed version, generated when evicted from hot memory */
  summary?: string;
  /** Token count of content */
  token_count?: number;
}
