import type { ConversationTurn } from '../types/llm.js';
import type { AlduinConfig } from '../config/types.js';
import { HotMemory } from './hot.js';
import { WarmMemory } from './warm.js';
import { ColdMemory } from './cold.js';
import { ContextReferenceDetector } from './detector.js';
import { TokenCounter } from '../tokens/counter.js';
import { redactSecrets } from './redactor.js';

/** Reserve this many tokens for system prompt + new message + model response */
const CONTEXT_RESERVE_TOKENS = 4000;

/**
 * Coordinates all memory tiers.
 * Callers use addTurn() and buildContext() — the tiered logic is internal.
 */
export class MemoryManager {
  private hot: HotMemory;
  private warm: WarmMemory;
  private cold: ColdMemory;
  private detector: ContextReferenceDetector;
  private config: AlduinConfig;
  private tokenCounter: TokenCounter;

  constructor(
    hot: HotMemory,
    warm: WarmMemory,
    cold: ColdMemory,
    detector: ContextReferenceDetector,
    config: AlduinConfig,
    tokenCounter: TokenCounter
  ) {
    this.hot = hot;
    this.warm = warm;
    this.cold = cold;
    this.detector = detector;
    this.config = config;
    this.tokenCounter = tokenCounter;
  }

  /**
   * Record a new conversation turn.
   * Hot memory stores the original content (short-lived, for in-session retrieval).
   * When a turn is evicted to warm/cold, secrets are redacted before promotion.
   */
  async addTurn(turn: ConversationTurn): Promise<void> {
    const evicted = this.hot.addTurn(turn);
    if (evicted) {
      const redactPii = this.config.memory?.redact_pii ?? false;
      const sanitised: ConversationTurn = {
        ...evicted,
        content: redactSecrets(evicted.content, redactPii),
      };
      await this.warm.absorbTurn(sanitised);
    }
  }

  /**
   * Build the context package for the next orchestrator call.
   *
   * Returns:
   * - systemContext: warm summary ± cold memory results (if reference detected)
   * - recentTurns: hot turns that fit within the token budget
   * - tokenCount: total tokens consumed by context + hot turns
   */
  async buildContext(
    newMessage: string,
    model: string
  ): Promise<{
    systemContext: string;
    recentTurns: ConversationTurn[];
    tokenCount: number;
  }> {
    const warmSummary = this.warm.getSummary();
    const hotTurns = this.hot.getTurns();
    const contextLimit =
      this.config.orchestrator.context_window - CONTEXT_RESERVE_TOKENS;

    // Check if the new message references past context
    let systemContext = warmSummary
      ? `Conversation summary:\n${warmSummary}`
      : '';

    const refDetected = this.detector.detectsReference(newMessage, hotTurns);
    if (refDetected && this.cold.size() > 0) {
      const coldResults = this.cold.search(newMessage);
      if (coldResults.length > 0) {
        const coldSection = coldResults.map((r) => r.summary).join('\n');
        systemContext = warmSummary
          ? `Conversation summary:\n${warmSummary}\n\nRelevant past context:\n${coldSection}`
          : `Relevant past context:\n${coldSection}`;
      }
    }

    // Calculate total token usage
    const systemContextTokens = systemContext
      ? this.tokenCounter.countTokens(systemContext, model)
      : 0;

    let usedTokens = systemContextTokens;
    let recentTurns = [...hotTurns];

    // Drop oldest hot turns if context is too large
    for (const turn of recentTurns) {
      usedTokens += this.tokenCounter.countTokens(turn.content, model) + 4;
    }

    while (usedTokens > contextLimit && recentTurns.length > 0) {
      const dropped = recentTurns.shift()!;
      usedTokens -= this.tokenCounter.countTokens(dropped.content, model) + 4;
    }

    // If still over limit (e.g. systemContext alone too big), truncate warm summary
    if (usedTokens > contextLimit && warmSummary) {
      const maxSummaryChars = Math.max(0, (contextLimit - 100) * 4);
      const truncated = warmSummary.substring(0, maxSummaryChars);
      systemContext = `Conversation summary:\n${truncated}`;
      usedTokens = this.tokenCounter.countTokens(systemContext, model);
      for (const turn of recentTurns) {
        usedTokens += this.tokenCounter.countTokens(turn.content, model) + 4;
      }
    }

    return { systemContext, recentTurns, tokenCount: usedTokens };
  }

  /**
   * End the current session:
   * flush warm summary to cold storage, then clear hot and warm.
   */
  async endSession(): Promise<void> {
    const rawSummary = this.warm.getSummary();
    if (rawSummary) {
      // Redact before persisting to cold storage
      const redactPii = this.config.memory?.redact_pii ?? false;
      const summary = redactSecrets(rawSummary, redactPii);

      const wordFreq = new Map<string, number>();
      for (const word of summary
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((w) => w.length > 3)) {
        wordFreq.set(word, (wordFreq.get(word) ?? 0) + 1);
      }
      const topics = [...wordFreq.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([w]) => w);

      this.cold.store(`session-${Date.now()}`, summary, {
        date: new Date(),
        topics,
      });
    }
    this.hot.clear();
    this.warm.clear();
  }

  /**
   * Wipe all memory tiers for this session.
   * Called by /alduin forget.
   */
  forget(): void {
    this.hot.clear();
    this.warm.clear();
    this.cold.clear();
  }

  /** Snapshot of current memory usage across all tiers */
  getStats(): { hot_turns: number; warm_tokens: number; cold_entries: number } {
    return {
      hot_turns: this.hot.size(),
      warm_tokens: this.warm.getTokenCount(),
      cold_entries: this.cold.size(),
    };
  }
}
