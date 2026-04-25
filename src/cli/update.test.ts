/**
 * Unit tests for alduin update.
 *
 * Mocks execSync and process.exit to verify branch decisions without
 * actually running git or npm.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { existsSync } from 'node:fs';

// We test the pure decision logic by mocking the child_process and fs modules.
// The handleUpdateCommand function is tested indirectly via module-level mocks.

vi.mock('node:child_process', () => ({
  execSync: vi.fn(),
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    existsSync: vi.fn(),
  };
});

vi.mock('@clack/prompts', () => ({
  confirm: vi.fn().mockResolvedValue(false),
}));

import * as childProcess from 'node:child_process';
import * as fs from 'node:fs';
import { confirm } from '@clack/prompts';

const mockExecSync = childProcess.execSync as ReturnType<typeof vi.fn>;
const mockExistsSync = fs.existsSync as ReturnType<typeof vi.fn>;
const mockConfirm = confirm as ReturnType<typeof vi.fn>;

function setupGitEnv(opts: {
  hasGit: boolean;
  dirty?: boolean;
  head?: string;
  incomingLog?: string;
  pullFails?: boolean;
  lockChanged?: boolean;
}) {
  mockExistsSync.mockImplementation((p: unknown) => {
    const str = String(p);
    if (str.endsWith('/.git') || str.endsWith('\\.git')) return opts.hasGit;
    return true; // other files exist
  });

  mockExecSync.mockImplementation((cmd: unknown) => {
    const c = String(cmd);
    if (c.includes('status --porcelain')) return opts.dirty ? 'M src/cli.ts\n' : '';
    if (c.includes('rev-parse HEAD') && !c.includes('abbrev-ref')) return opts.head ?? 'abc123def456';
    if (c.includes('fetch --tags')) return '';
    if (c.includes('abbrev-ref')) return 'origin/main';
    if (c.includes('log --oneline HEAD..')) return opts.incomingLog ?? '';
    if (c.includes('pull --ff-only')) {
      if (opts.pullFails) throw new Error('git pull: local commits diverged');
      return '';
    }
    if (c.includes('diff') && c.includes('package-lock.json'))
      return opts.lockChanged ? '--- a/package-lock.json\n+++ b/package-lock.json\n' : '';
    if (c.includes('npm install') || c.includes('npm run build')) return '';
    return '';
  });
}

describe('alduin update', () => {
  let processExitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    processExitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process.exit called');
    }) as never);
  });

  afterEach(() => {
    vi.clearAllMocks();
    processExitSpy.mockRestore();
  });

  it('exits with error when not a git checkout', async () => {
    setupGitEnv({ hasGit: false });
    const { handleUpdateCommand } = await import('./update.js?t=' + Date.now());

    await expect(handleUpdateCommand([])).rejects.toThrow('process.exit called');
    expect(processExitSpy).toHaveBeenCalledWith(1);
  });

  it('exits with error when working tree is dirty', async () => {
    setupGitEnv({ hasGit: true, dirty: true });
    const { handleUpdateCommand } = await import('./update.js?t=' + Date.now());

    await expect(handleUpdateCommand([])).rejects.toThrow('process.exit called');
    expect(processExitSpy).toHaveBeenCalledWith(1);
  });

  it('prints "Already up to date" when no incoming commits', async () => {
    setupGitEnv({ hasGit: true, dirty: false, incomingLog: '' });
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const { handleUpdateCommand } = await import('./update.js?t=' + Date.now());
    await expect(handleUpdateCommand([])).rejects.toThrow('process.exit called');
    expect(processExitSpy).toHaveBeenCalledWith(0);
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('up to date'));

    consoleSpy.mockRestore();
  });

  it('exits with error on non-fast-forward pull', async () => {
    setupGitEnv({
      hasGit: true,
      dirty: false,
      incomingLog: 'abc Fix bug\ndef Add feature',
      pullFails: true,
    });
    mockConfirm.mockResolvedValueOnce(true); // confirm the upgrade

    const { handleUpdateCommand } = await import('./update.js?t=' + Date.now());
    await expect(handleUpdateCommand([])).rejects.toThrow('process.exit called');
    expect(processExitSpy).toHaveBeenCalledWith(1);
  });
});
