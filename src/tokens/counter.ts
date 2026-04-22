import { get_encoding, type Tiktoken } from 'tiktoken';
import { countTokens as anthropicCountTokens } from '@anthropic-ai/tokenizer';
import type { LLMMessage } from '../types/llm.js';
import type { ModelCatalog } from '../catalog/catalog.js';

/** Token framing overhead per message (role + separators) */
const MESSAGE_FRAMING_TOKENS = 4;

/**
 * Counts tokens using real tokenizers — never character-count heuristics.
 *
 * Tokenizer selection reads from the catalog's `tokenizer` field:
 *   - "anthropic"    → @anthropic-ai/tokenizer
 *   - "cl100k_base"  → tiktoken cl100k_base
 *   - "o200k_base"   → tiktoken o200k_base
 *
 * When no catalog is provided, falls back to prefix-based heuristics
 * for backward compatibility during testing.
 *
 * Encoder instances are cached so they're not recreated per call.
 */
export class TokenCounter {
  private encoderCache: Map<string, Tiktoken> = new Map();
  private catalog: ModelCatalog | null;

  constructor(catalog?: ModelCatalog) {
    this.catalog = catalog ?? null;
  }

  /** Get or create a tiktoken encoder, cached by encoding name. */
  private getTiktokenEncoder(encoding: string): Tiktoken {
    const cached = this.encoderCache.get(encoding);
    if (cached) return cached;

    const encoder = get_encoding(encoding as Parameters<typeof get_encoding>[0]);
    this.encoderCache.set(encoding, encoder);
    return encoder;
  }

  /**
   * Count tokens in a text string for the given model.
   * Reads the tokenizer from the catalog when available; otherwise falls back
   * to prefix-based heuristics (anthropic/ → anthropic, else cl100k_base).
   *
   * @param text - The text to tokenize
   * @param model - Fully-qualified model string (e.g. "anthropic/claude-sonnet-4-6")
   */
  countTokens(text: string, model: string): number {
    const tokenizer = this.resolveTokenizer(model);

    if (tokenizer === 'anthropic') {
      return anthropicCountTokens(text);
    }

    const encoder = this.getTiktokenEncoder(tokenizer);
    return encoder.encode(text).length;
  }

  /**
   * Estimate total tokens for an array of messages.
   * Each message incurs MESSAGE_FRAMING_TOKENS overhead for role and separators.
   */
  estimateMessageTokens(messages: LLMMessage[], model: string): number {
    let total = 0;
    for (const message of messages) {
      total += this.countTokens(message.content, model);
      total += MESSAGE_FRAMING_TOKENS;
    }
    return total;
  }

  /**
   * Resolve the tokenizer to use for a model.
   * Priority: catalog lookup → prefix-based fallback.
   */
  private resolveTokenizer(model: string): 'anthropic' | 'cl100k_base' | 'o200k_base' {
    if (this.catalog) {
      const tokenizerName = this.catalog.getTokenizer(model);
      if (tokenizerName) return tokenizerName;
    }

    // Fallback: prefix-based heuristic (backward compat for tests without a catalog)
    if (model.startsWith('anthropic/') || model.startsWith('claude')) {
      return 'anthropic';
    }

    if (!model.startsWith('openai/') && !model.startsWith('gpt')) {
      console.warn(
        `[TokenCounter] Unknown model "${model}" not in catalog, falling back to cl100k_base`
      );
    }

    return 'cl100k_base';
  }
}
