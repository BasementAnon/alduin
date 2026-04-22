import type { PluginContext } from './context.js';
/**
 * Message role in an LLM conversation.
 * Mirrors src/types/llm.ts — kept separate so the SDK has no imports from
 * the Alduin core.  The loader validates compatibility at registration time.
 */
export type MessageRole = 'system' | 'user' | 'assistant' | 'tool';
/** A single message in a conversation. */
export interface PluginLLMMessage {
    role: MessageRole;
    content: string;
    tool_call_id?: string;
    name?: string;
}
/** Tool parameter definition (JSON Schema subset). */
export interface PluginToolParameter {
    type: string;
    description?: string;
    enum?: string[];
    properties?: Record<string, PluginToolParameter>;
    required?: string[];
    items?: PluginToolParameter;
}
/** A tool the model can call. */
export interface PluginLLMTool {
    name: string;
    description: string;
    parameters: PluginToolParameter;
}
/** A tool call made by the model. */
export interface PluginLLMToolCall {
    id: string;
    name: string;
    arguments: Record<string, unknown>;
}
/** Token usage from a completion. */
export interface PluginLLMUsage {
    input_tokens: number;
    output_tokens: number;
    cache_read_tokens?: number;
    cache_write_tokens?: number;
}
/** Request to an LLM provider (plugin-facing). */
export interface PluginLLMCompletionRequest {
    model: string;
    messages: PluginLLMMessage[];
    max_tokens: number;
    temperature?: number;
    tools?: PluginLLMTool[];
    stop_sequences?: string[];
    response_format?: {
        type: 'json_object' | 'text';
    };
}
/** Response from an LLM provider (plugin-facing). */
export interface PluginLLMCompletionResponse {
    content: string;
    tool_calls?: PluginLLMToolCall[];
    usage: PluginLLMUsage;
    model: string;
    finish_reason: 'stop' | 'max_tokens' | 'tool_use' | 'error';
}
/** Structured error from an LLM provider. */
export interface PluginLLMError {
    type: 'rate_limit' | 'auth' | 'context_overflow' | 'timeout' | 'invalid_request' | 'provider_error';
    message: string;
    retryable: boolean;
    retry_after_ms?: number;
    status_code?: number;
}
/**
 * A chunk emitted during streaming completion (plugin-facing).
 * Mirrors LLMStreamChunk from src/types/llm.ts.
 */
export type PluginLLMStreamChunk = {
    type: 'delta';
    content: string;
} | {
    type: 'tool_call_start';
    id: string;
    name: string;
} | {
    type: 'tool_call_delta';
    id: string;
    arguments_delta: string;
} | {
    type: 'usage';
    usage: PluginLLMUsage;
} | {
    type: 'finish';
    finish_reason: PluginLLMCompletionResponse['finish_reason'];
    usage?: PluginLLMUsage;
};
/** Result type (mirrors Alduin's Result<T, E>). */
export type PluginResult<T, E> = {
    ok: true;
    value: T;
} | {
    ok: false;
    error: E;
};
/**
 * The interface a provider plugin must implement.
 *
 * Provider plugins are dumb transport — they translate between the Alduin
 * LLM contract and a specific API.  Pricing and tokenizer selection come
 * from the model catalog, not from the plugin.
 */
export interface ProviderPlugin {
    /** Provider identifier — must match what the manifest declares. */
    readonly id: string;
    /** Complete a chat conversation. */
    complete(request: PluginLLMCompletionRequest, ctx: PluginContext): Promise<PluginResult<PluginLLMCompletionResponse, PluginLLMError>>;
    /** Count tokens in a text string for this provider's models. */
    countTokens(text: string, model?: string): number;
    /**
     * Stream a completion. When present, the host prefers this over
     * `complete()` for user-facing turns.
     */
    streamComplete?: (request: PluginLLMCompletionRequest, ctx: PluginContext) => AsyncIterable<PluginLLMStreamChunk>;
}
//# sourceMappingURL=provider.d.ts.map