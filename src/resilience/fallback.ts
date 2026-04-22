import { CircuitBreaker } from './circuit-breaker.js';
import { ProviderRegistry } from '../providers/registry.js';
import type { LLMCompletionRequest, LLMCompletionResponse, LLMError } from '../types/llm.js';
import type { Result } from '../types/result.js';
import { ok, err } from '../types/result.js';

/** LLMCompletionResponse extended with which model actually served the request */
export type FallbackResponse = LLMCompletionResponse & { actual_model: string };

/**
 * Wraps LLM calls with automatic fallback across a model chain.
 * Each model has its own circuit breaker that opens after repeated failures.
 *
 * Example chain: anthropic/claude-opus-4-6 → anthropic/claude-sonnet-4-6 → openai/gpt-4.1
 * If Opus is rate-limited, Sonnet is tried. If Sonnet's circuit is open, GPT-4.1 is tried.
 */
export class FallbackChain {
  private providerRegistry: ProviderRegistry;
  private fallbackConfig: Record<string, string[]>;
  private circuitBreakers: Map<string, CircuitBreaker>;

  constructor(
    providerRegistry: ProviderRegistry,
    fallbackConfig: Record<string, string[]>,
    circuitBreakers: Map<string, CircuitBreaker> = new Map()
  ) {
    this.providerRegistry = providerRegistry;
    this.fallbackConfig = fallbackConfig;
    this.circuitBreakers = circuitBreakers;
  }

  /**
   * Attempt a completion request, falling through the fallback chain on failure.
   *
   * @param modelString - Primary model (e.g. "anthropic/claude-opus-4-6")
   * @param request - The completion request (model field will be updated per attempt)
   */
  async callWithFallback(
    modelString: string,
    request: LLMCompletionRequest
  ): Promise<Result<FallbackResponse, LLMError>> {
    const chain = [modelString, ...(this.fallbackConfig[modelString] ?? [])];
    const attempted: string[] = [];

    for (const model of chain) {
      const breaker = this.getOrCreateBreaker(model);

      if (!breaker.canCall()) {
        console.warn(`[FallbackChain] Circuit open for ${model}, skipping`);
        continue;
      }

      const provider = this.providerRegistry.resolveProvider(model);
      if (!provider) {
        console.warn(`[FallbackChain] No provider registered for ${model}, skipping`);
        continue;
      }

      const modelName = this.providerRegistry.resolveModelName(model);
      const attemptRequest: LLMCompletionRequest = { ...request, model: modelName };

      attempted.push(model);
      const result = await provider.complete(attemptRequest);

      if (result.ok) {
        breaker.recordSuccess();
        return ok({ ...result.value, actual_model: model });
      }

      // Failed — record and decide whether to try next model or retry
      breaker.recordFailure();

      if (result.error.retryable && result.error.retry_after_ms && attempted.length === 1) {
        // Retry once on the primary model after the backoff period
        await sleep(result.error.retry_after_ms);
        const retry = await provider.complete(attemptRequest);
        if (retry.ok) {
          breaker.recordSuccess();
          return ok({ ...retry.value, actual_model: model });
        }
        breaker.recordFailure();
      }

      // Continue to next model in chain
    }

    const allAttempted = attempted.length > 0 ? attempted.join(', ') : chain.join(', ');
    return err({
      type: 'provider_error',
      message: `All models in fallback chain failed. Attempted: ${allAttempted}`,
      retryable: false,
    });
  }

  /** Get the circuit breaker for a model, creating it lazily if needed. */
  private getOrCreateBreaker(model: string): CircuitBreaker {
    const existing = this.circuitBreakers.get(model);
    if (existing) return existing;
    const breaker = new CircuitBreaker();
    this.circuitBreakers.set(model, breaker);
    return breaker;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
