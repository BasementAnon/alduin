import OpenAI from 'openai';
import { OpenAIProvider } from './openai.js';
import type { ModelCatalog } from '../catalog/catalog.js';

/**
 * OpenAI-compatible provider adapter.
 * Identical to OpenAIProvider but configured with a custom baseURL.
 * Used for DeepSeek, Together AI, Fireworks, and other OpenAI-compatible APIs.
 */
export class OpenAICompatibleProvider extends OpenAIProvider {
  // id is intentionally widened to allow the 'openai-compatible' string literal
  readonly id: string = 'openai-compatible';

  constructor(baseUrl: string, apiKey: string, catalog?: ModelCatalog, timeoutMs?: number) {
    super(apiKey, catalog, timeoutMs);
    // Replace the client with one pointing to the custom base URL, preserving timeout.
    const resolvedTimeout = timeoutMs ?? 60_000;
    this.client = new OpenAI({ apiKey, baseURL: baseUrl, timeout: resolvedTimeout });
  }
}
