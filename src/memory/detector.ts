import type { ConversationTurn } from '../types/llm.js';

/** Phrases that signal the user is referencing something from a past session */
const EXPLICIT_REFERENCE_PHRASES = [
  'remember when',
  'like before',
  'we discussed',
  'last time',
  'you said',
  'earlier you',
  'as we talked about',
  'the thing we',
  'continue from',
  'go back to',
  'previously',
  'you mentioned',
  'what we did',
  'our earlier',
  'from before',
];

/** Determiners that may introduce a dangling noun reference */
const DANGLING_DETERMINERS = ['that', 'the', 'those'];

/**
 * Pure string-matching detector for past context references.
 * No LLM calls — this must be fast and free.
 *
 * Detects two patterns:
 * 1. Explicit phrase references ("remember when", "we discussed", …)
 * 2. Dangling definite references ("that project", "the file") where the noun
 *    doesn't appear in any of the current hot turns.
 */
export class ContextReferenceDetector {
  /**
   * Returns true if the message appears to reference past context
   * not present in the current hot memory turns.
   */
  detectsReference(message: string, hotTurns: ConversationTurn[]): boolean {
    const lower = message.toLowerCase();

    // 1. Check for explicit reference phrases
    for (const phrase of EXPLICIT_REFERENCE_PHRASES) {
      if (lower.includes(phrase)) return true;
    }

    // 2. Check for dangling definite references
    const words = lower.split(/\s+/);
    for (let i = 0; i < words.length; i++) {
      const word = words[i]?.replace(/[^a-z]/g, '') ?? '';
      if (DANGLING_DETERMINERS.includes(word)) {
        // Extract next 1–2 words as the potential noun phrase
        const noun1 = (words[i + 1] ?? '').replace(/[^a-z]/g, '');
        const noun2 = (words[i + 2] ?? '').replace(/[^a-z]/g, '');

        if (noun1.length > 2) {
          const hotContent = hotTurns.map((t) => t.content.toLowerCase()).join(' ');
          // If neither noun word appears in hot memory, it references something older
          if (!hotContent.includes(noun1) && (!noun2 || !hotContent.includes(noun2))) {
            return true;
          }
        }
      }
    }

    return false;
  }
}
