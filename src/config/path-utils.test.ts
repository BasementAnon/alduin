import { describe, it, expect } from 'vitest';
import { setDeep, validatePath, FORBIDDEN_KEYS } from './path-utils.js';

describe('path-utils prototype pollution guards (M-2)', () => {
  it('exposes the canonical FORBIDDEN_KEYS set', () => {
    expect(FORBIDDEN_KEYS.has('__proto__')).toBe(true);
    expect(FORBIDDEN_KEYS.has('prototype')).toBe(true);
    expect(FORBIDDEN_KEYS.has('constructor')).toBe(true);
  });

  describe('setDeep', () => {
    it('rejects paths containing __proto__', () => {
      const obj: Record<string, unknown> = {};
      expect(() => setDeep(obj, ['__proto__', 'polluted'], true)).toThrow(
        /forbidden path segment/
      );
      // The global Object prototype must remain unmolested.
      expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
    });

    it('rejects paths containing prototype', () => {
      const obj: Record<string, unknown> = {};
      expect(() => setDeep(obj, ['foo', 'prototype', 'bar'], 1)).toThrow(
        /forbidden path segment/
      );
    });

    it('rejects paths containing constructor', () => {
      const obj: Record<string, unknown> = {};
      expect(() => setDeep(obj, ['constructor', 'prototype', 'x'], 1)).toThrow(
        /forbidden path segment/
      );
    });

    it('accepts ordinary nested paths', () => {
      const obj: Record<string, unknown> = {};
      setDeep(obj, ['a', 'b', 'c'], 42);
      expect((obj as { a: { b: { c: unknown } } }).a.b.c).toBe(42);
    });

    it('creates intermediate objects with no prototype chain', () => {
      const obj: Record<string, unknown> = {};
      setDeep(obj, ['a', 'b'], 1);
      const intermediate = (obj as { a: object }).a;
      // Object.create(null) means there's no inherited toString, etc. — a
      // crafted child key like "toString" cannot accidentally override the
      // prototype chain because there isn't one.
      expect(Object.getPrototypeOf(intermediate)).toBeNull();
    });
  });

  describe('validatePath', () => {
    it('refuses __proto__ as a path segment even under a known prefix', () => {
      expect(() => validatePath(['providers', '__proto__', 'polluted'])).toThrow(
        /forbidden path segment/
      );
    });

    it('refuses a bare __proto__ path', () => {
      expect(() => validatePath(['__proto__'])).toThrow(/forbidden path segment/);
    });
  });
});
