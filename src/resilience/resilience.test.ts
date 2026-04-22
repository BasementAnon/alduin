import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CircuitBreaker } from './circuit-breaker.js';
import { FallbackChain } from './fallback.js';
import { ProviderRegistry } from '../providers/registry.js';
import type { LLMProvider, LLMCompletionRequest } from '../types/llm.js';

function mockProvider(id: string): LLMProvider & { complete: ReturnType<typeof vi.fn> } {
  return {
    id,
    complete: vi.fn(),
    countTokens: () => 0,
    estimateCost: () => 0,
  };
}

const baseRequest: LLMCompletionRequest = {
  model: 'claude-opus-4-6',
  messages: [{ role: 'user', content: 'Hello' }],
  max_tokens: 100,
};

// ── CircuitBreaker ────────────────────────────────────────────────────────────
describe('CircuitBreaker', () => {
  it('starts in closed state and allows calls', () => {
    const cb = new CircuitBreaker();
    expect(cb.getState()).toBe('closed');
    expect(cb.canCall()).toBe(true);
  });

  it('opens after reaching the error threshold', () => {
    const cb = new CircuitBreaker(3);
    cb.recordFailure();
    cb.recordFailure();
    expect(cb.getState()).toBe('closed');
    cb.recordFailure(); // threshold reached
    expect(cb.getState()).toBe('open');
    expect(cb.canCall()).toBe(false);
  });

  it('transitions to half_open after reset timeout elapses', () => {
    const cb = new CircuitBreaker(1, 0); // instant timeout
    cb.recordFailure();
    expect(cb.getState()).toBe('open');
    // timeout is 0ms so it should immediately be eligible to test
    expect(cb.canCall()).toBe(true);
    expect(cb.getState()).toBe('half_open');
  });

  it('closes after a successful call in half_open state', () => {
    const cb = new CircuitBreaker(1, 0);
    cb.recordFailure(); // opens
    cb.canCall(); // transitions to half_open
    cb.recordSuccess(); // test call succeeded → close
    expect(cb.getState()).toBe('closed');
    expect(cb.canCall()).toBe(true);
  });

  it('reset() forces the circuit back to closed', () => {
    const cb = new CircuitBreaker(1);
    cb.recordFailure();
    expect(cb.getState()).toBe('open');
    cb.reset();
    expect(cb.getState()).toBe('closed');
    expect(cb.canCall()).toBe(true);
  });
});

// ── FallbackChain ─────────────────────────────────────────────────────────────
describe('FallbackChain', () => {
  let registry: ProviderRegistry;
  let primary: ReturnType<typeof mockProvider>;
  let fallback: ReturnType<typeof mockProvider>;
  let chain: FallbackChain;

  beforeEach(() => {
    vi.clearAllMocks();
    registry = new ProviderRegistry();
    primary = mockProvider('anthropic');
    fallback = mockProvider('openai');
    registry.register('anthropic', primary);
    registry.register('openai', fallback);

    chain = new FallbackChain(
      registry,
      { 'anthropic/claude-opus-4-6': ['openai/gpt-4.1'] },
      new Map()
    );
  });

  it('returns response from primary on success', async () => {
    primary.complete.mockResolvedValue({
      ok: true,
      value: {
        content: 'Primary response',
        usage: { input_tokens: 10, output_tokens: 5 },
        model: 'claude-opus-4-6',
        finish_reason: 'stop',
      },
    });

    const result = await chain.callWithFallback('anthropic/claude-opus-4-6', baseRequest);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.content).toBe('Primary response');
      expect(result.value.actual_model).toBe('anthropic/claude-opus-4-6');
    }
    expect(fallback.complete).not.toHaveBeenCalled();
  });

  it('falls through to the fallback model on primary failure', async () => {
    primary.complete.mockResolvedValue({
      ok: false,
      error: { type: 'provider_error' as const, message: 'Overloaded', retryable: false },
    });
    fallback.complete.mockResolvedValue({
      ok: true,
      value: {
        content: 'Fallback response',
        usage: { input_tokens: 10, output_tokens: 5 },
        model: 'gpt-4.1',
        finish_reason: 'stop',
      },
    });

    const result = await chain.callWithFallback('anthropic/claude-opus-4-6', baseRequest);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.content).toBe('Fallback response');
      expect(result.value.actual_model).toBe('openai/gpt-4.1');
    }
  });

  it('opens circuit after threshold failures and skips that model', async () => {
    const breakers = new Map<string, CircuitBreaker>();
    const openBreaker = new CircuitBreaker(1);
    // Pre-open the circuit
    openBreaker.recordFailure();
    breakers.set('anthropic/claude-opus-4-6', openBreaker);

    const strictChain = new FallbackChain(
      registry,
      { 'anthropic/claude-opus-4-6': ['openai/gpt-4.1'] },
      breakers
    );

    fallback.complete.mockResolvedValue({
      ok: true,
      value: {
        content: 'Fallback only',
        usage: { input_tokens: 5, output_tokens: 3 },
        model: 'gpt-4.1',
        finish_reason: 'stop',
      },
    });

    const result = await strictChain.callWithFallback('anthropic/claude-opus-4-6', baseRequest);
    // Primary should have been skipped (circuit open)
    expect(primary.complete).not.toHaveBeenCalled();
    expect(result.ok).toBe(true);
  });

  it('returns comprehensive error when all models fail', async () => {
    primary.complete.mockResolvedValue({
      ok: false,
      error: { type: 'provider_error' as const, message: 'Primary down', retryable: false },
    });
    fallback.complete.mockResolvedValue({
      ok: false,
      error: { type: 'provider_error' as const, message: 'Fallback down', retryable: false },
    });

    const result = await chain.callWithFallback('anthropic/claude-opus-4-6', baseRequest);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.type).toBe('provider_error');
      expect(result.error.message).toContain('All models');
    }
  });

  it('retries once on retryable primary error before falling through', async () => {
    primary.complete
      .mockResolvedValueOnce({
        ok: false,
        error: {
          type: 'rate_limit' as const,
          message: 'Rate limited',
          retryable: true,
          retry_after_ms: 1, // 1ms so test doesn't hang
        },
      })
      .mockResolvedValueOnce({
        ok: true,
        value: {
          content: 'Retry succeeded',
          usage: { input_tokens: 8, output_tokens: 4 },
          model: 'claude-opus-4-6',
          finish_reason: 'stop',
        },
      });

    const result = await chain.callWithFallback('anthropic/claude-opus-4-6', baseRequest);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.content).toBe('Retry succeeded');
      expect(result.value.actual_model).toBe('anthropic/claude-opus-4-6');
    }
    // Fallback should never have been called
    expect(fallback.complete).not.toHaveBeenCalled();
  });
});
