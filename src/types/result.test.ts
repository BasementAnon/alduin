import { describe, it, expect } from 'vitest';
import { ok, err, unwrap, map, flatMap, collect } from '../types/result.js';

describe('Result type', () => {
  it('ok wraps a value', () => {
    const result = ok(42);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toBe(42);
    }
  });

  it('err wraps an error', () => {
    const result = err('something broke');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe('something broke');
    }
  });

  it('unwrap returns value for ok', () => {
    expect(unwrap(ok(10))).toBe(10);
  });

  it('unwrap throws for err', () => {
    expect(() => unwrap(err('fail'))).toThrow();
  });

  it('map transforms ok values', () => {
    const result = map(ok(5), (x) => x * 2);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe(10);
  });

  it('map passes through errors', () => {
    const result = map(err('nope'), (x: number) => x * 2);
    expect(result.ok).toBe(false);
  });

  it('flatMap chains results', () => {
    const divide = (a: number, b: number) =>
      b === 0 ? err('div by zero' as const) : ok(a / b);

    const result = flatMap(ok(10), (x) => divide(x, 2));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe(5);

    const errResult = flatMap(ok(10), (x) => divide(x, 0));
    expect(errResult.ok).toBe(false);
  });

  it('collect gathers ok results', () => {
    const results = [ok(1), ok(2), ok(3)];
    const collected = collect(results);
    expect(collected.ok).toBe(true);
    if (collected.ok) expect(collected.value).toEqual([1, 2, 3]);
  });

  it('collect short-circuits on first error', () => {
    const results = [ok(1), err('fail'), ok(3)];
    const collected = collect(results);
    expect(collected.ok).toBe(false);
    if (!collected.ok) expect(collected.error).toBe('fail');
  });
});
