import { describe, it, expect, vi, afterEach } from 'vitest';
import { raceWithTimeout } from './timeout.js';

describe('raceWithTimeout', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('resolves with the promise value when it completes before the deadline', async () => {
    const result = await raceWithTimeout(Promise.resolve(42), 1000);
    expect(result).toBe(42);
  });

  it('rejects with a timeout error when the deadline fires first', async () => {
    vi.useFakeTimers();
    const never = new Promise<never>(() => { /* intentionally never resolves */ });

    const race = raceWithTimeout(never, 500);
    vi.advanceTimersByTime(500);

    await expect(race).rejects.toThrow('Timeout after 500ms');
  });

  it('uses a custom message when provided', async () => {
    vi.useFakeTimers();
    const never = new Promise<never>(() => { /* never resolves */ });

    const race = raceWithTimeout(never, 100, 'Tool "foo" timed out after 100ms');
    vi.advanceTimersByTime(100);

    await expect(race).rejects.toThrow('Tool "foo" timed out after 100ms');
  });

  it('clears the timer handle on successful resolution (no handle leak)', async () => {
    const clearSpy = vi.spyOn(globalThis, 'clearTimeout');
    await raceWithTimeout(Promise.resolve('done'), 5000);
    // clearTimeout must have been called exactly once (in the finally block)
    expect(clearSpy).toHaveBeenCalledTimes(1);
    clearSpy.mockRestore();
  });

  it('clears the timer handle on upstream rejection (no handle leak)', async () => {
    const clearSpy = vi.spyOn(globalThis, 'clearTimeout');
    await expect(
      raceWithTimeout(Promise.reject(new Error('upstream error')), 5000)
    ).rejects.toThrow('upstream error');
    expect(clearSpy).toHaveBeenCalledTimes(1);
    clearSpy.mockRestore();
  });

  it('propagates non-timeout upstream rejections as-is', async () => {
    const boom = new Error('unexpected crash');
    await expect(raceWithTimeout(Promise.reject(boom), 1000)).rejects.toBe(boom);
  });
});
