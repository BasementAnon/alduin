import { describe, it, expect, beforeEach } from 'vitest';
import { HotMemory } from './hot.js';
import { TokenCounter } from '../tokens/counter.js';
import type { ConversationTurn } from '../types/llm.js';

function turn(role: 'user' | 'assistant', content: string): ConversationTurn {
  return { role, content, timestamp: new Date() };
}

describe('HotMemory', () => {
  let hot: HotMemory;

  beforeEach(() => {
    hot = new HotMemory(3);
  });

  it('returns null when adding a turn under the limit', () => {
    expect(hot.addTurn(turn('user', 'Hello'))).toBeNull();
    expect(hot.addTurn(turn('assistant', 'Hi!'))).toBeNull();
    expect(hot.size()).toBe(2);
  });

  it('evicts the oldest turn when the limit is exceeded and returns it', () => {
    hot.addTurn(turn('user', 'First'));
    hot.addTurn(turn('assistant', 'Second'));
    hot.addTurn(turn('user', 'Third'));

    const evicted = hot.addTurn(turn('assistant', 'Fourth'));

    expect(evicted).not.toBeNull();
    expect(evicted!.content).toBe('First');
    expect(hot.size()).toBe(3);
    // Oldest is gone
    expect(hot.getTurns()[0]!.content).toBe('Second');
  });

  it('getTurns returns a copy, not a reference', () => {
    hot.addTurn(turn('user', 'Hello'));
    const copy = hot.getTurns();
    copy.push(turn('user', 'Extra'));
    // Internal state should not be affected
    expect(hot.size()).toBe(1);
  });

  it('getTokenCount sums token counts across all turns', () => {
    hot.addTurn(turn('user', 'Hello'));        // 1 token
    hot.addTurn(turn('assistant', 'Hi there')); // 2 tokens

    const counter = new TokenCounter();
    const count = hot.getTokenCount(counter, 'openai/gpt-4.1');
    const expected =
      counter.countTokens('Hello', 'openai/gpt-4.1') +
      counter.countTokens('Hi there', 'openai/gpt-4.1');
    expect(count).toBe(expected);
  });

  it('clear empties all turns', () => {
    hot.addTurn(turn('user', 'Hello'));
    hot.addTurn(turn('assistant', 'Hi'));
    hot.clear();
    expect(hot.size()).toBe(0);
    expect(hot.getTurns()).toHaveLength(0);
  });

  it('respects a custom maxTurns of 1', () => {
    const tiny = new HotMemory(1);
    tiny.addTurn(turn('user', 'First'));
    const evicted = tiny.addTurn(turn('assistant', 'Second'));
    expect(evicted!.content).toBe('First');
    expect(tiny.size()).toBe(1);
    expect(tiny.getTurns()[0]!.content).toBe('Second');
  });
});
