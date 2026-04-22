import { ProviderRegistry } from '../providers/registry.js';
import { TokenCounter } from '../tokens/counter.js';
import type { LLMCompletionRequest } from '../types/llm.js';

/** Config subset needed by the summarizer */
export interface SummarizerConfig {
  /** Fully-qualified model string for the cheap/fast summarization model */
  model: string;
  /** Max tokens for the summarization call itself */
  max_tokens: number;
}

/**
 * Summarizes executor results before returning them to the orchestrator.
 * Uses a cheap/fast model to condense long outputs into ~300-token summaries.
 * This prevents the orchestrator's context from growing with every completed task.
 */
export class ResultSummarizer {
  private providerRegistry: ProviderRegistry;
  private config: SummarizerConfig;
  private tokenCounter: TokenCounter;

  constructor(providerRegistry: ProviderRegistry, config: SummarizerConfig) {
    this.providerRegistry = providerRegistry;
    this.config = config;
    this.tokenCounter = new TokenCounter();
  }

  /**
   * Summarize a raw executor output.
   * If the output is already short enough, returns it as-is without an LLM call.
   *
   * @param executorName - Name of the executor that produced the output
   * @param rawOutput - The full executor output
   * @param maxSummaryTokens - Target summary length in tokens (default 300)
   */
  async summarize(
    executorName: string,
    rawOutput: string,
    maxSummaryTokens: number = 300
  ): Promise<string> {
    const outputTokens = this.tokenCounter.countTokens(rawOutput, this.config.model);
    if (outputTokens <= maxSummaryTokens) {
      return rawOutput;
    }

    const provider = this.providerRegistry.resolveProvider(this.config.model);
    if (!provider) {
      return this.truncateToTokenLimit(rawOutput, maxSummaryTokens);
    }

    const modelName = this.providerRegistry.resolveModelName(this.config.model);

    const request: LLMCompletionRequest = {
      model: modelName,
      messages: [
        {
          role: 'user',
          content:
            `Summarize this ${executorName} task output concisely. ` +
            `Include: what was accomplished, key decisions made, file paths created, ` +
            `and any issues encountered. Keep under ${maxSummaryTokens} tokens.\n\n` +
            `Output:\n${rawOutput}`,
        },
      ],
      max_tokens: maxSummaryTokens,
    };

    const result = await provider.complete(request);
    if (result.ok) {
      return result.value.content;
    }

    // LLM call failed — fall back to truncation
    return this.truncateToTokenLimit(rawOutput, maxSummaryTokens);
  }

  /**
   * Truncate text to approximately maxTokens by iteratively trimming.
   * Uses the token counter to ensure accuracy rather than character heuristics.
   */
  private truncateToTokenLimit(text: string, maxTokens: number): string {
    // Rough estimate: ~4 chars per token for initial cut
    const estimatedChars = maxTokens * 4;
    let truncated = text.slice(0, estimatedChars);

    let count = this.tokenCounter.countTokens(truncated, this.config.model);
    while (count > maxTokens && truncated.length > 0) {
      truncated = truncated.slice(0, Math.floor(truncated.length * 0.8));
      count = this.tokenCounter.countTokens(truncated, this.config.model);
    }

    return truncated + (truncated.length < text.length ? '...' : '');
  }
}
