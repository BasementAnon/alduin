import type { ConversationTurn } from '../types/llm.js';
import { TokenCounter } from '../tokens/counter.js';

/**
 * Hot memory — the most recent conversation turns kept always in-context.
 * When full, the oldest turn is evicted and returned to be absorbed by warm memory.
 */
export class HotMemory {
  private turns: ConversationTurn[] = [];
  private maxTurns: number;

  constructor(maxTurns: number = 3) {
    this.maxTurns = maxTurns;
  }

  /**
   * Add a turn to hot memory.
   * If the buffer is full, evicts and returns the oldest turn so it can be
   * absorbed by warm memory. Returns null when no eviction occurs.
   */
  addTurn(turn: ConversationTurn): ConversationTurn | null {
    this.turns.push(turn);
    if (this.turns.length > this.maxTurns) {
      return this.turns.shift() ?? null;
    }
    return null;
  }

  /** Returns a shallow copy of the current turns array */
  getTurns(): ConversationTurn[] {
    return [...this.turns];
  }

  /** Count total tokens across all turn contents */
  getTokenCount(tokenCounter: TokenCounter, model: string): number {
    return this.turns.reduce(
      (sum, turn) => sum + tokenCounter.countTokens(turn.content, model),
      0
    );
  }

  /** Remove all turns */
  clear(): void {
    this.turns = [];
  }

  /** Number of turns currently in hot memory */
  size(): number {
    return this.turns.length;
  }
}
