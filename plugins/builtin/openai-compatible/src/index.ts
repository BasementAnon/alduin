/**
 * OpenAI-compatible builtin provider plugin entry.
 *
 * Wraps the existing OpenAICompatibleProvider transport for use with
 * DeepSeek, Together AI, Fireworks, Groq, and other OpenAI-compatible APIs.
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

import { OpenAICompatibleProvider } from '../../../../src/providers/openai-compatible.js';

let cachedProvider: OpenAICompatibleProvider | null = null;

function getOrCreateProvider(_ctx: PluginContext): OpenAICompatibleProvider {
  if (cachedProvider) return cachedProvider;
  // OpenAI-compatible providers require a base_url from config.
  // For the builtin plugin, fall back to env vars / defaults.
  const baseUrl = process.env['OPENAI_COMPATIBLE_BASE_URL'] ?? 'https://api.deepseek.com/v1';
  const apiKey = process.env['OPENAI_COMPATIBLE_API_KEY'] ?? process.env['DEEPSEEK_API_KEY'] ?? '';
  cachedProvider = new OpenAICompatibleProvider(baseUrl, apiKey);
  return cachedProvider;
}

export const provider: ProviderPlugin = {
  id: 'openai-compatible',

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
      response_format: request.response_format,
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
      response_format: request.response_format,
    });
  },

  countTokens(text: string, _model?: string): number {
    // OpenAI-compatible providers use the same tokenizer as OpenAI
    const prov = getOrCreateProvider({
      log: { info() {}, warn() {}, error() {}, debug() {} },
      async getCredential() { return null; },
      getConfig() { return undefined; },
    });
    return prov.countTokens(text, 'deepseek-v3.2');
  },
};

export default definePlugin({
  id: 'openai-compatible',
  version: '0.1.0',
  kind: 'provider',
  entry: './src/index.ts',
  providers: ['openai-compatible'],
  contributes: {
    config_schema: './schema.json',
    models_catalog: './models.json',
  },
});
