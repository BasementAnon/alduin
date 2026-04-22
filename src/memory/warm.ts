import type { ConversationTurn } from '../types/llm.js';
import type { AlduinConfig } from '../config/types.js';
import { ProviderRegistry } from '../providers/registry.js';
import { TokenCounter } from '../tokens/counter.js';
import { redactSecrets } from './redactor.js';

const DEFAULT_MAX_TOKENS = 500;

/**
 * Warm memory — a rolling summary of past conversation turns.
 * Always present in context (~500 tokens). Updated via a cheap LLM call each
 * time a turn is evicted from hot memory.
 */
export class WarmMemory {
  private summary: string = '';
  private summaryTokens: number = 0;
  private maxTokens: number;
  private providerRegistry: ProviderRegistry;
  private config: AlduinConfig;
  private tokenCounter: TokenCounter;
  /** Mirror of config.memory?.redact_pii — cached to avoid repeated optional-chaining. */
  private redactPii: boolean;

  constructor(
    providerRegistry: ProviderRegistry,
    config: AlduinConfig,
    tokenCounter: TokenCounter
  ) {
    this.providerRegistry = providerRegistry;
    this.config = config;
    this.tokenCounter = tokenCounter;
    this.maxTokens = config.memory?.warm_max_tokens ?? DEFAULT_MAX_TOKENS;
    this.redactPii = config.memory?.redact_pii ?? false;
  }

  /**
   * Absorb an evicted turn into the rolling summary.
   * - First turn: creates the initial summary inline (no LLM call).
   * - Subsequent turns: calls the cheap model to update the summary.
   * - On LLM failure: falls back to appending a truncated version of the turn.
   */
  async absorbTurn(turn: ConversationTurn): Promise<void> {
    const turnText = `${turn.role}: ${turn.content}`;

    if (this.summary === '') {
      // First turn — no LLM call needed
      const maxChars = this.maxTokens * 4; // ~4 chars per token
      this.summary = redactSecrets(turnText.substring(0, maxChars), this.redactPii);
      this.updateTokenCount();
      return;
    }

    const updated = await this.callSummarizationModel(turnText);
    if (updated !== null) {
      this.summary = redactSecrets(updated, this.redactPii);
    } else {
      // Fallback: append the new turn content (redacted) then truncate
      this.summary += redactSecrets(`\n${turn.role}: ${turn.content.substring(0, 200)}`, this.redactPii);
      const maxChars = this.maxTokens * 4;
      // Re-redact after truncation — safe because redactSecrets is idempotent
      this.summary = redactSecrets(this.summary.substring(0, maxChars), this.redactPii);
    }
    this.updateTokenCount();
  }

  getSummary(): string {
    return this.summary;
  }

  getTokenCount(): number {
    return this.summaryTokens;
  }

  clear(): void {
    this.summary = '';
    this.summaryTokens = 0;
  }

  /**
   * Resolve and call the cheap model to compress the growing summary.
   * Returns the updated summary string, or null on failure.
   */
  private async callSummarizationModel(newTurnText: string): Promise<string | null> {
    const classifierExecutorName = this.config.routing.classifier_model;
    const executorConfig = this.config.executors[classifierExecutorName];
    if (!executorConfig) return null;

    const modelString = executorConfig.model;
    const provider = this.providerRegistry.resolveProvider(modelString);
    if (!provider) return null;

    const modelName = this.providerRegistry.resolveModelName(modelString);

    const result = await provider.complete({
      model: modelName,
      messages: [
        {
          role: 'user',
          content:
            `Update this conversation summary with the new exchange. ` +
            `Preserve: key decisions, user preferences stated, task outcomes, and open items. ` +
            `Drop greetings and filler. Stay under ${this.maxTokens} tokens.\n\n` +
            `Current summary:\n${this.summary}\n\n` +
            `New exchange:\n${newTurnText}`,
        },
      ],
      max_tokens: this.maxTokens,
    });

    return result.ok ? result.value.content : null;
  }

  private updateTokenCount(): void {
    // Use a stable model for counting — the warm summary is model-agnostic
    this.summaryTokens = this.tokenCounter.countTokens(
      this.summary,
      'openai/gpt-4.1'
    );
  }
}
