import { describe, it, expect } from 'vitest';
import { runInSandbox } from './sandbox.js';

describe('runInSandbox', () => {
  it('executes simple code and returns the result', async () => {
    const result = await runInSandbox('return 2 + 2;', {});
    expect(result.ok).toBe(true);
    expect(result.value).toBe('4');
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('passes INPUT to the code', async () => {
    const result = await runInSandbox(
      'return INPUT.a + INPUT.b;',
      { a: 10, b: 20 }
    );
    expect(result.ok).toBe(true);
    expect(result.value).toBe('30');
  });

  it('handles async code', async () => {
    const result = await runInSandbox(
      'return await Promise.resolve("hello");',
      {}
    );
    expect(result.ok).toBe(true);
    expect(result.value).toBe('"hello"');
  });

  it('returns error for code that throws', async () => {
    const result = await runInSandbox(
      'throw new Error("boom");',
      {}
    );
    expect(result.ok).toBe(false);
    expect(result.error).toContain('boom');
  });

  it('returns null for void code', async () => {
    const result = await runInSandbox('const x = 1;', {});
    expect(result.ok).toBe(true);
    expect(result.value).toBe('null');
  });

  it('blocks fs access by default', async () => {
    const result = await runInSandbox(
      'const fs = require("fs"); return fs.readdirSync(".");',
      {}
    );
    expect(result.ok).toBe(false);
    expect(result.error).toContain('not allowed');
  });

  it('blocks net access by default', async () => {
    const result = await runInSandbox(
      'const http = require("http"); return "ok";',
      {}
    );
    expect(result.ok).toBe(false);
    expect(result.error).toContain('not allowed');
  });

  it('blocks child_process always', async () => {
    const result = await runInSandbox(
      'const cp = require("child_process"); return "ok";',
      {},
      { allowFs: true, allowNet: true }
    );
    expect(result.ok).toBe(false);
    expect(result.error).toContain('not allowed');
  });

  it('allows fs when explicitly enabled', async () => {
    const result = await runInSandbox(
      'const fs = require("fs"); return typeof fs.readFileSync;',
      {},
      { allowFs: true }
    );
    expect(result.ok).toBe(true);
    expect(result.value).toBe('"function"');
  });

  it('enforces timeout', async () => {
    const result = await runInSandbox(
      'while(true) {}',
      {},
      { timeoutMs: 500 }
    );
    expect(result.ok).toBe(false);
    expect(result.error).toContain('timeout');
    expect(result.durationMs).toBeGreaterThanOrEqual(400);
  }, 10_000);

  it('reports duration on success', async () => {
    const result = await runInSandbox('return 1;', {});
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect(result.durationMs).toBeLessThan(5000);
  });
});
