/**
 * Step 0 — Prerequisites check.
 *
 * Runs silently before any interactive prompts. Verifies:
 *   1. Node.js version ≥ 22
 *   2. node_modules/ exists (npm install ran)
 *   3. dist/ exists and is at least as recent as src/ (build is current)
 *
 * On failure, prints exactly which command to run and exits.
 */

import { existsSync, statSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { log } from '@clack/prompts';

export interface PrerequisiteFailure {
  check: string;
  message: string;
  fix: string;
}

/**
 * Get the most recent mtime in a directory tree (recursive, capped depth).
 * Returns 0 if the directory does not exist.
 */
function latestMtime(dir: string, maxDepth = 5): number {
  if (!existsSync(dir)) return 0;

  let latest = 0;

  function walk(current: string, depth: number): void {
    if (depth > maxDepth) return;
    let entries: string[];
    try {
      entries = readdirSync(current);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry === 'node_modules' || entry.startsWith('.')) continue;
      const full = join(current, entry);
      try {
        const st = statSync(full);
        if (st.isDirectory()) {
          walk(full, depth + 1);
        } else {
          if (st.mtimeMs > latest) latest = st.mtimeMs;
        }
      } catch {
        // skip inaccessible
      }
    }
  }

  walk(dir, 0);
  return latest;
}

/**
 * Run all prerequisite checks. Returns an array of failures (empty = all OK).
 */
export function checkPrerequisites(): PrerequisiteFailure[] {
  const failures: PrerequisiteFailure[] = [];

  // 1. Node version
  const nodeVersion = process.versions.node;
  const major = parseInt(nodeVersion.split('.')[0] ?? '0', 10);
  if (major < 22) {
    failures.push({
      check: 'Node.js version',
      message: `Found Node.js v${nodeVersion}, but Alduin requires v22 or later.`,
      fix: 'Install Node.js 22+: https://nodejs.org/ or `nvm install 22`',
    });
  }

  // 2. node_modules
  if (!existsSync('node_modules')) {
    failures.push({
      check: 'Dependencies',
      message: 'node_modules/ not found — dependencies have not been installed.',
      fix: 'Run: npm install',
    });
  }

  // 3. Build freshness
  if (!existsSync('dist')) {
    failures.push({
      check: 'Build output',
      message: 'dist/ not found — the project has not been built.',
      fix: 'Run: alduin build',
    });
  } else {
    const srcTime = latestMtime('src');
    const distTime = latestMtime('dist');
    if (srcTime > 0 && distTime > 0 && srcTime > distTime) {
      failures.push({
        check: 'Build freshness',
        message: 'Source files are newer than dist/ — the build is stale.',
        fix: 'Run: alduin build',
      });
    }
  }

  return failures;
}

/**
 * Run prerequisites and log failures. Returns true if all checks passed.
 */
export function runPrerequisites(): boolean {
  const failures = checkPrerequisites();

  if (failures.length === 0) return true;

  log.error('Prerequisites check failed:\n');
  for (const f of failures) {
    log.error(`  ✗ ${f.check}: ${f.message}`);
    log.info(`    → ${f.fix}`);
  }
  log.info('');

  return false;
}
