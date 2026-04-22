/**
 * Ollama builtin provider plugin entry.
 *
 * Wraps the existing OllamaProvider transport for local inference.
 * estimateCost() always returns 0 -- local inference is free.
 */

import { definePlugin } from '@alduin/plugin-sdk';
import type {
  ProviderPlugin,
  PluginLLMCompletionRequest,
  PluginLLMCompletionResponse,
  PluginLLMError,
  PluginLLMStreamChunk,
  PluginResult,
  PluginContext,
} from '@alduin/plugin-sdk';

import { OllamaProvider } from '../../../../src/providers/ollama.js';

let cachedProvider: OllamaProvider | null = null;

function getOrCreateProvider(_ctx: PluginContext): OllamaProvider {
  if (cachedProvider) return cachedProvider;
  const baseUrl = process.env['OLLAMA_BASE_URL'] ?? 'http://localhost:11434';
  cachedProvider = new OllamaProvider(baseUrl);
  return cachedProvider;
}

export const provider: ProviderPlugin = {
  id: 'ollama',

  async complete(
    request: PluginLLMCompletionRequest,
    ctx: PluginContext,
  ): Promise<PluginResult<PluginLLMCompletionResponse, PluginLLMError>> {
    const prov = getOrCreateProvider(ctx);
    const result = await prov.complete({
      model: request.model,
      messages: request.messages.map((m) => ({
        role: m.role,
        content: m.content,
        tool_call_id: m.tool_call_id,
        name: m.name,
      })),
      max_tokens: request.max_tokens,
      temperature: request.temperature,
      stop_sequences: request.stop_sequences,
    });

    if (!result.ok) {
      return {
        ok: false,
        error: {
          type: result.error.type,
          message: result.error.message,
          retryable: result.error.retryable,
          retry_after_ms: result.error.retry_after_ms,
          status_code: result.error.status_code,
        },
      };
    }

    return {
      ok: true,
      value: {
        content: result.value.content,
        usage: {
          input_tokens: result.value.usage.input_tokens,
          output_tokens: result.value.usage.output_tokens,
        },
        model: result.value.model,
        finish_reason: result.value.finish_reason,
      },
    };
  },

  async *streamComplete(
    request: PluginLLMCompletionRequest,
    ctx: PluginContext,
  ): AsyncIterable<PluginLLMStreamChunk> {
    const prov = getOrCreateProvider(ctx);
    yield* prov.streamComplete({
      model: request.model,
      messages: request.messages.map((m) => ({
        role: m.role,
        content: m.content,
        tool_call_id: m.tool_call_id,
        name: m.name,
      })),
      max_tokens: request.max_tokens,
      temperature: request.temperature,
      stop_sequences: request.stop_sequences,
    });
  },

  countTokens(text: string, model?: string): number {
    const prov = getOrCreateProvider({
      log: { info() {}, warn() {}, error() {}, debug() {} },
      async getCredential() { return null; },
      getConfig() { return undefined; },
    });
    return prov.countTokens(text, model ?? 'qwen2.5-7b');
  },
};

export default definePlugin({
  id: 'ollama',
  version: '0.1.0',
  kind: 'provider',
  entry: './src/index.ts',
  providers: ['ollama'],
  contributes: {
    config_schema: './schema.json',
    models_catalog: './models.json',
  },
});
