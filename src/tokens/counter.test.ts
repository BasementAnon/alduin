import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TokenCounter } from './counter.js';
import type { LLMMessage } from '../types/llm.js';

describe('TokenCounter', () => {
  let counter: TokenCounter;

  beforeEach(() => {
    counter = new TokenCounter();
  });

  describe('countTokens', () => {
    it('counts tokens for a known string with cl100k_base (OpenAI model)', () => {
      // "Hello, world!" → 4 tokens with cl100k_base
      const count = counter.countTokens('Hello, world!', 'openai/gpt-4.1');
      expect(count).toBe(4);
    });

    it('counts tokens for a Claude model using Anthropic tokenizer', () => {
      // @anthropic-ai/tokenizer countTokens("Hello, world!") → 4
      const count = counter.countTokens('Hello, world!', 'anthropic/claude-sonnet-4-6');
      expect(count).toBeGreaterThan(0);
      expect(typeof count).toBe('number');
    });

    it('matches claude- prefix as an Anthropic model', () => {
      const count = counter.countTokens('Hello, world!', 'claude-3-opus');
      expect(count).toBeGreaterThan(0);
    });

    it('falls back to cl100k_base for unknown model and warns', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const count = counter.countTokens('Hello, world!', 'unknown/some-model');
      expect(count).toBe(4);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('Unknown model')
      );

      warnSpy.mockRestore();
    });

    it('reuses cached encoder instances across calls', () => {
      // Access the private cache via bracket notation for inspection
      const tc = counter as unknown as { encoderCache: Map<string, unknown> };

      counter.countTokens('first call', 'openai/gpt-4.1');
      const sizeAfterFirst = tc.encoderCache.size;

      counter.countTokens('second call', 'openai/gpt-4.1');
      const sizeAfterSecond = tc.encoderCache.size;

      // Cache should not grow — same encoder reused
      expect(sizeAfterFirst).toBe(1);
      expect(sizeAfterSecond).toBe(1);
    });
  });

  describe('estimateMessageTokens', () => {
    it('counts message content tokens plus framing overhead per message', () => {
      const messages: LLMMessage[] = [
        { role: 'user', content: 'Hello, world!' },
        { role: 'assistant', content: 'Hi there!' },
      ];

      const total = counter.estimateMessageTokens(messages, 'openai/gpt-4.1');

      // "Hello, world!" = 4 tokens, "Hi there!" = 3 tokens
      // Plus 4 framing tokens per message = (4+4) + (3+4) = 15
      const contentTokens =
        counter.countTokens('Hello, world!', 'openai/gpt-4.1') +
        counter.countTokens('Hi there!', 'openai/gpt-4.1');
      const framingTokens = 4 * messages.length;
      expect(total).toBe(contentTokens + framingTokens);
    });

    it('returns 0 for empty messages array', () => {
      expect(counter.estimateMessageTokens([], 'openai/gpt-4.1')).toBe(0);
    });

    it('framing overhead adds 4 tokens per message', () => {
      const singleWord: LLMMessage[] = [{ role: 'user', content: 'Hi' }];
      const contentOnly = counter.countTokens('Hi', 'openai/gpt-4.1');
      const withFraming = counter.estimateMessageTokens(singleWord, 'openai/gpt-4.1');
      expect(withFraming).toBe(contentOnly + 4);
    });
  });
});
