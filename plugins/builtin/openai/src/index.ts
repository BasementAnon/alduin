/**
 * OpenAI builtin provider plugin entry.
 *
 * Wraps the existing OpenAIProvider transport to expose it through
 * the ProviderPlugin interface.
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

import { OpenAIProvider } from '../../../../src/providers/openai.js';

let cachedProvider: OpenAIProvider | null = null;

function getOrCreateProvider(_ctx: PluginContext): OpenAIProvider {
  if (cachedProvider) return cachedProvider;
  const apiKey = process.env['OPENAI_API_KEY'] ?? '';
  cachedProvider = new OpenAIProvider(apiKey);
  return cachedProvider;
}

export const provider: ProviderPlugin = {
  id: 'openai',

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

  countTokens(text: string, model?: string): number {
    const prov = getOrCreateProvider({
      log: { info() {}, warn() {}, error() {}, debug() {} },
      async getCredential() { return null; },
      getConfig() { return undefined; },
    });
    return prov.countTokens(text, model ?? 'gpt-4.1');
  },
};

export default definePlugin({
  id: 'openai',
  version: '0.1.0',
  kind: 'provider',
  entry: './src/index.ts',
  providers: ['openai'],
  providerAuthEnvVars: { openai: ['OPENAI_API_KEY'] },
  contributes: {
    config_schema: './schema.json',
    models_catalog: './models.json',
  },
});
