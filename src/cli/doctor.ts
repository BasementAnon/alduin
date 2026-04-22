/**
 * `alduin doctor [--fix]` — health check and auto-migration CLI.
 *
 * Delegates to modular rules under src/cli/doctor/rules/.
 * Each rule implements DoctorRule and is self-contained.
 *
 */

import { resolve } from 'node:path';
import { loadCatalog } from '../catalog/catalog.js';
import { loadConfig } from '../config/loader.js';
import { renderTable } from '../util/table.js';
import type { CheckStatus, DoctorCheckResult, DoctorContext } from './doctor/rule.js';
import { runRules } from './doctor/runner.js';
import { ALL_RULES } from './doctor/rules/index.js';

// ── Public options (matches the old interface for CLI compat) ────────────────

export type { CheckStatus } from './doctor/rule.js';

export interface DoctorCheck extends DoctorCheckResult {}

export interface DoctorOptions {
  configPath: string;
  vaultPath?: string;
  /** When true, attempt to apply automatic fixes. */
  fix?: boolean;
  /** Environment variable map (defaults to process.env). */
  env?: Record<string, string | undefined>;
  /** Skip vault-related checks (for test environments). */
  skipVault?: boolean;
}

// ── Main runner ──────────────────────────────────────────────────────────────

/** Collect all doctor checks, optionally applying fixes. */
export async function runDoctorChecks(opts: DoctorOptions): Promise<DoctorCheck[]> {
  const {
    configPath,
    vaultPath = '.alduin/vault.db',
    fix = false,
    env = process.env as Record<string, string | undefined>,
    skipVault = false,
  } = opts;

  const root = resolve(process.cwd());

  // Load catalog (non-fatal if missing)
  const catalogResult = loadCatalog();
  const catalog = catalogResult.ok ? catalogResult.value : null;

  // Load config (non-fatal if missing)
  const configResult = loadConfig(configPath, null, env);
  const config = configResult.ok ? configResult.value : null;

  const ctx: DoctorContext = {
    configPath,
    vaultPath,
    root,
    config,
    catalog,
    env,
    skipVault,
    fix,
  };

  const { checks, fixLog } = await runRules(ALL_RULES, ctx);

  if (fix && fixLog.length > 0) {
    console.log('\nFix log:');
    fixLog.forEach((msg) => console.log(`  → ${msg}`));
    console.log('');
  }

  return checks;
}

// ── Output rendering ─────────────────────────────────────────────────────────

const STATUS_SYMBOLS: Record<CheckStatus, string> = {
  pass:  '✓ pass',
  fail:  '✗ fail',
  warn:  '⚠ warn',
  skip:  '○ skip',
  fixed: '↪ fixed',
};

/**
 * Render a DoctorCheck array as an ANSI table string.
 * The returned string has no trailing newline.
 */
export function formatDoctorTable(checks: DoctorCheck[], configPath?: string): string {
  const header = configPath ? `Alduin Doctor — ${configPath}` : 'Alduin Doctor';

  const table = renderTable({
    columns: [
      { key: 'label', header: 'Check', minWidth: 22 },
      { key: 'status', header: 'Status', minWidth: 8 },
      { key: 'detail', header: 'Detail', flex: true },
    ],
    rows: checks.map((c) => ({
      label: c.label,
      status: STATUS_SYMBOLS[c.status],
      detail: c.detail,
    })),
    border: 'unicode',
    padding: 1,
    width: 80,
  });

  const allPassed = checks.every((c) => c.status === 'pass' || c.status === 'skip' || c.status === 'fixed');
  const summary = allPassed ? 'All checks passed.' : `${checks.filter((c) => c.status === 'fail').length} check(s) failed.`;

  return `${header}\n${table}\n${summary}`;
}

// ── CLI entry point ──────────────────────────────────────────────────────────

/**
 * Handle `alduin doctor [--fix]` from the CLI.
 */
export async function handleDoctorCommand(opts: DoctorOptions): Promise<void> {
  const checks = await runDoctorChecks(opts);
  const output = formatDoctorTable(checks, opts.configPath);
  console.log(output);

  const hasFail = checks.some((c) => c.status === 'fail');
  if (hasFail) process.exit(1);
}
