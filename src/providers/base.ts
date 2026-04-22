import type {
  LLMProvider,
  LLMCompletionRequest,
  LLMCompletionResponse,
  LLMError,
  LLMUsage,
  LLMStreamChunk,
} from '../types/llm.js';
import type { Result } from '../types/result.js';
import type { ModelCatalog } from '../catalog/catalog.js';

/**
 * Base class for LLM provider adapters.
 * Providers are dumb transport — pricing comes from the model catalog,
 * not from hardcoded constants.
 */
export abstract class BaseProvider implements LLMProvider {
  abstract readonly id: string;
  protected catalog: ModelCatalog | null;

  constructor(catalog?: ModelCatalog) {
    this.catalog = catalog ?? null;
  }

  abstract complete(
    request: LLMCompletionRequest
  ): Promise<Result<LLMCompletionResponse, LLMError>>;

  abstract streamComplete(
    request: LLMCompletionRequest
  ): AsyncIterable<LLMStreamChunk>;

  abstract countTokens(text: string, model: string): number;

  /**
   * Estimate cost in USD using the catalog's pricing data.
   * Falls back to 0 when the model is not in the catalog (e.g. local models).
   */
  estimateCost(model: string, usage: LLMUsage): number {
    // model may be an api_id (e.g. "claude-sonnet-4-6") or a fully-qualified
    // string (e.g. "anthropic/claude-sonnet-4-6"). Try the qualified form first.
    const pricing = this.catalog
      ? (this.catalog.getPricing(`${this.id}/${model}`) ?? this.catalog.getPricing(model))
      : null;

    if (!pricing) return 0;

    const inputCost = (usage.input_tokens / 1_000_000) * pricing.input;
    const outputCost = (usage.output_tokens / 1_000_000) * pricing.output;

    return inputCost + outputCost;
  }

  /**
   * Build a standardized LLMError from a provider-specific error.
   * Subclasses call this to normalize errors.
   */
  protected buildError(
    type: LLMError['type'],
    message: string,
    options?: {
      retryable?: boolean;
      retry_after_ms?: number;
      status_code?: number;
    }
  ): LLMError {
    return {
      type,
      message,
      retryable: options?.retryable ?? false,
      retry_after_ms: options?.retry_after_ms,
      provider: this.id,
      status_code: options?.status_code,
    };
  }
}
