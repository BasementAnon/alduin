import { describe, it, expect, vi } from 'vitest';
import { consumeStream, type StreamConsumerCallbacks } from './stream-consumer.js';
import type { LLMStreamChunk, LLMUsage } from '../types/llm.js';

/** Helper to create an async iterable from an array of chunks */
async function* mockStream(chunks: LLMStreamChunk[]): AsyncIterable<LLMStreamChunk> {
  for (const chunk of chunks) {
    yield chunk;
  }
}

/** Async iterable with delays between chunks */
async function* delayedStream(
  chunks: LLMStreamChunk[],
  delayMs: number
): AsyncIterable<LLMStreamChunk> {
  for (const chunk of chunks) {
    await new Promise((r) => setTimeout(r, delayMs));
    yield chunk;
  }
}

describe('consumeStream', () => {
  it('accumulates delta chunks into full content', async () => {
    const chunks: LLMStreamChunk[] = [
      { type: 'delta', content: 'Hello' },
      { type: 'delta', content: ' world' },
      { type: 'delta', content: '!' },
      { type: 'finish', finish_reason: 'stop', usage: { input_tokens: 10, output_tokens: 3 } },
    ];

    const onPartial = vi.fn();
    const onUsage = vi.fn();

    const result = await consumeStream(mockStream(chunks), { onPartial, onUsage }, 0);

    expect(result.content).toBe('Hello world!');
    expect(result.finish_reason).toBe('stop');
    expect(result.usage.input_tokens).toBe(10);
    expect(result.usage.output_tokens).toBe(3);
    expect(result.aborted).toBe(false);
  });

  it('delivers onPartial at throttle intervals', async () => {
    const chunks: LLMStreamChunk[] = [
      { type: 'delta', content: 'a' },
      { type: 'delta', content: 'b' },
      { type: 'delta', content: 'c' },
      { type: 'finish', finish_reason: 'stop' },
    ];

    const onPartial = vi.fn();
    const onUsage = vi.fn();

    // With throttle = 0, every delta triggers onPartial
    await consumeStream(mockStream(chunks), { onPartial, onUsage }, 0);

    // All 3 deltas + final flush
    expect(onPartial).toHaveBeenCalled();
    // The final call should have the complete content
    const lastCall = onPartial.mock.calls[onPartial.mock.calls.length - 1]!;
    expect(lastCall[0]).toBe('abc');
  });

  it('throttles rapid deltas', async () => {
    // Many deltas with no delay — throttle should limit calls
    const deltas: LLMStreamChunk[] = Array.from({ length: 20 }, (_, i) => ({
      type: 'delta' as const,
      content: String.fromCharCode(65 + (i % 26)),
    }));
    deltas.push({ type: 'finish', finish_reason: 'stop' });

    const onPartial = vi.fn();
    const onUsage = vi.fn();

    // Throttle 5000ms — should only fire once (first delta) + final flush
    await consumeStream(mockStream(deltas), { onPartial, onUsage }, 5000);

    // With 5s throttle and near-instant iteration, we get 1 throttled + 1 final
    expect(onPartial.mock.calls.length).toBeLessThanOrEqual(3);
  });

  it('flows usage through onUsage callback', async () => {
    const chunks: LLMStreamChunk[] = [
      { type: 'delta', content: 'Hi' },
      { type: 'usage', usage: { input_tokens: 100, output_tokens: 50 } },
      { type: 'finish', finish_reason: 'stop', usage: { input_tokens: 100, output_tokens: 50 } },
    ];

    const onUsage = vi.fn();
    await consumeStream(mockStream(chunks), { onPartial: vi.fn(), onUsage }, 0);

    // Called twice: once for usage chunk, once for finish
    expect(onUsage).toHaveBeenCalledTimes(2);
    expect(onUsage).toHaveBeenCalledWith({ input_tokens: 100, output_tokens: 50 });
  });

  it('aborts when shouldAbort returns true', async () => {
    let count = 0;
    const chunks: LLMStreamChunk[] = [
      { type: 'delta', content: 'a' },
      { type: 'delta', content: 'b' },
      { type: 'delta', content: 'c' },
      { type: 'delta', content: 'd' },
      { type: 'finish', finish_reason: 'stop' },
    ];

    const onPartial = vi.fn();
    const onUsage = vi.fn();

    const result = await consumeStream(
      mockStream(chunks),
      { onPartial, onUsage },
      0,
      () => {
        count++;
        return count > 2; // Abort after processing 2 chunks
      }
    );

    expect(result.aborted).toBe(true);
    expect(result.content.length).toBeLessThan(4); // Did not get all 4 deltas
  });

  it('assembles tool calls from start + delta chunks', async () => {
    const chunks: LLMStreamChunk[] = [
      { type: 'tool_call_start', id: 'tc1', name: 'get_weather' },
      { type: 'tool_call_delta', id: 'tc1', arguments_delta: '{"loc' },
      { type: 'tool_call_delta', id: 'tc1', arguments_delta: 'ation":"NYC"}' },
      { type: 'finish', finish_reason: 'tool_use' },
    ];

    const onToolCallStart = vi.fn();
    const onToolCallDelta = vi.fn();

    const result = await consumeStream(
      mockStream(chunks),
      { onPartial: vi.fn(), onUsage: vi.fn(), onToolCallStart, onToolCallDelta },
      0
    );

    expect(result.finish_reason).toBe('tool_use');
    expect(result.tool_calls).toHaveLength(1);
    expect(result.tool_calls[0]!.name).toBe('get_weather');
    expect(result.tool_calls[0]!.arguments).toEqual({ location: 'NYC' });
    expect(onToolCallStart).toHaveBeenCalledWith('tc1', 'get_weather');
    expect(onToolCallDelta).toHaveBeenCalledTimes(2);
  });

  it('handles empty stream gracefully', async () => {
    const result = await consumeStream(
      mockStream([{ type: 'finish', finish_reason: 'stop' }]),
      { onPartial: vi.fn(), onUsage: vi.fn() },
      0
    );

    expect(result.content).toBe('');
    expect(result.finish_reason).toBe('stop');
    expect(result.tool_calls).toHaveLength(0);
  });

  it('handles malformed tool call arguments', async () => {
    const chunks: LLMStreamChunk[] = [
      { type: 'tool_call_start', id: 'tc1', name: 'bad_tool' },
      { type: 'tool_call_delta', id: 'tc1', arguments_delta: 'not valid json' },
      { type: 'finish', finish_reason: 'tool_use' },
    ];

    const result = await consumeStream(
      mockStream(chunks),
      { onPartial: vi.fn(), onUsage: vi.fn() },
      0
    );

    expect(result.tool_calls).toHaveLength(1);
    expect(result.tool_calls[0]!.arguments).toEqual({ _raw: 'not valid json' });
  });

  it('chunk order: deltas → usage → finish', async () => {
    const order: string[] = [];

    const chunks: LLMStreamChunk[] = [
      { type: 'delta', content: 'Hi' },
      { type: 'usage', usage: { input_tokens: 5, output_tokens: 1 } },
      { type: 'finish', finish_reason: 'stop' },
    ];

    await consumeStream(
      mockStream(chunks),
      {
        onPartial: () => order.push('partial'),
        onUsage: () => order.push('usage'),
      },
      0
    );

    // Partial comes first, then usage (from usage chunk), then usage (from finish)
    expect(order[0]).toBe('partial');
    expect(order).toContain('usage');
  });
});
