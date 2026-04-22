/**
 * Worker-thread isolation for skill code modules.
 *
 * ⚠ NOT A SECURITY BOUNDARY. The historical name "sandbox" is retained
 * for code-identifier stability only (C-1: docs say what this is,
 * identifiers do not change). This is a `worker_threads` wrapper with
 * a coarse `require` filter — it cannot resist a determined adversary.
 * In particular:
 *   - `worker_threads` share the Node.js process memory; a native-code
 *     exploit can escape.
 *   - There is no seccomp/landlock/AppArmor confinement, no file
 *     descriptor revocation, no CPU share limit.
 *   - The memory cap (--max-old-space-size) is advisory and does not
 *     account for ArrayBuffers or off-heap allocations.
 *
 * Treat this as a **soft isolation layer** for well-behaved but
 * potentially buggy skill code, not as a barrier against untrusted
 * input or malicious plugins. A real sandbox (isolated-vm, separate
 * OS process with seccomp, etc.) is tracked as future work.
 *
 * Runtime controls that ARE enforced:
 *  - Time limit (default 30 s) via worker termination
 *  - Advisory memory cap via --max-old-space-size (default 128 MiB)
 *  - Require-path filter: fs/net gated on allow_fs/allow_net;
 *    child_process and worker_threads are always blocked
 *
 * The runner evaluates a skill's code body and returns the result as JSON.
 */

import { Worker } from 'node:worker_threads';

/** Options for sandbox execution */
export interface SandboxOptions {
  /** Time limit in milliseconds. Default: 30_000 (30 s). */
  timeoutMs?: number;
  /** Heap size limit in MiB for the worker. Default: 128. */
  maxHeapMiB?: number;
  /** Allow require('fs') and file I/O. Default: false. */
  allowFs?: boolean;
  /** Allow require('http'/'https'/'net'). Default: false. */
  allowNet?: boolean;
}

/** Outcome of a sandbox run */
export interface SandboxResult {
  ok: boolean;
  /** Serialized return value (JSON string) on success. */
  value?: string;
  /** Error message on failure. */
  error?: string;
  /** Wall-clock milliseconds the worker ran. */
  durationMs: number;
}

/**
 * Build the worker script that will execute inside the thread.
 *
 * The script:
 * 1. Conditionally blocks fs/net by overriding Module._resolveFilename
 * 2. Evaluates the user-provided code string
 * 3. Posts the result back to the parent
 */
function buildWorkerScript(
  code: string,
  input: Record<string, unknown>,
  opts: Required<Pick<SandboxOptions, 'allowFs' | 'allowNet'>>
): string {
  const blockedModules: string[] = [];
  if (!opts.allowFs) {
    blockedModules.push('fs', 'fs/promises', 'node:fs', 'node:fs/promises');
  }
  if (!opts.allowNet) {
    blockedModules.push(
      'http', 'https', 'net', 'tls', 'dgram',
      'node:http', 'node:https', 'node:net', 'node:tls', 'node:dgram'
    );
  }

  // Always block child_process and worker_threads (no spawning from sandbox)
  blockedModules.push(
    'child_process', 'node:child_process',
    'worker_threads', 'node:worker_threads'
  );

  const blockedList = JSON.stringify(blockedModules);
  const inputJson = JSON.stringify(input);

  // The worker code is a self-contained CommonJS script.
  // We wrap the user code in an async IIFE so it can use await.
  return `
'use strict';
const { parentPort } = require('worker_threads');

// Block restricted modules
const Module = require('module');
const _origResolve = Module._resolveFilename;
const BLOCKED = new Set(${blockedList});

Module._resolveFilename = function(request, ...args) {
  if (BLOCKED.has(request)) {
    throw new Error('Module "' + request + '" is not allowed in the skill sandbox');
  }
  return _origResolve.call(this, request, ...args);
};

const INPUT = ${inputJson};

(async () => {
  try {
    // Wrap user code in an async function so await works inside skill code
    const AsyncFunction = Object.getPrototypeOf(async function(){}).constructor;
    const userFn = new AsyncFunction('INPUT', ${JSON.stringify(
      `'use strict';\n${code}\n`
    )});
    const result = await userFn(INPUT);
    parentPort.postMessage({ ok: true, value: JSON.stringify(result ?? null) });
  } catch (err) {
    parentPort.postMessage({ ok: false, error: err?.message ?? String(err) });
  }
})();
`;
}

/**
 * Run a code string inside a sandboxed worker thread.
 *
 * @param code    The skill's code body (JavaScript)
 * @param input   Input data passed as `INPUT` variable to the code
 * @param opts    Sandbox constraints
 * @returns       SandboxResult with value or error
 */
export function runInSandbox(
  code: string,
  input: Record<string, unknown> = {},
  opts: SandboxOptions = {}
): Promise<SandboxResult> {
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const maxHeapMiB = opts.maxHeapMiB ?? 128;
  const allowFs = opts.allowFs ?? false;
  const allowNet = opts.allowNet ?? false;

  const script = buildWorkerScript(code, input, { allowFs, allowNet });
  const start = Date.now();

  return new Promise<SandboxResult>((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const worker = new Worker(script, {
      eval: true,
      resourceLimits: {
        maxOldGenerationSizeMb: maxHeapMiB,
        maxYoungGenerationSizeMb: Math.max(16, Math.floor(maxHeapMiB / 4)),
      },
    });

    function settle(result: SandboxResult): void {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(result);
    }

    worker.on('message', (msg: { ok: boolean; value?: string; error?: string }) => {
      settle({
        ok: msg.ok,
        value: msg.value,
        error: msg.error,
        durationMs: Date.now() - start,
      });
      worker.terminate().catch(() => {});
    });

    worker.on('error', (err: Error) => {
      settle({
        ok: false,
        error: `Worker error: ${err.message}`,
        durationMs: Date.now() - start,
      });
    });

    worker.on('exit', (exitCode: number) => {
      if (!settled) {
        settle({
          ok: false,
          error: `Worker exited with code ${exitCode}`,
          durationMs: Date.now() - start,
        });
      }
    });

    // Enforce time limit
    timer = setTimeout(() => {
      worker.terminate().catch(() => {});
      settle({
        ok: false,
        error: `Sandbox timeout: exceeded ${timeoutMs}ms limit`,
        durationMs: Date.now() - start,
      });
    }, timeoutMs);
  });
}
