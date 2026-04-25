/**
 * alduin update — self-updater.
 *
 * Verified: no alduin update command existed before this commit.
 * src/cli/skills.ts has `update <id>` for skills only; src/cli.ts has no
 * update handler; package.json bin points to wrapper script (no update logic).
 *
 * Flow:
 *   1. Confirm this is a git checkout (look for .git)
 *   2. Reject if working tree is dirty
 *   3. Record current HEAD
 *   4. git fetch --tags origin
 *   5. Diff HEAD vs upstream — exit early if already up to date
 *   6. Show incoming commits (up to 20), confirm upgrade
 *   7. git pull --ff-only — abort on non-fast-forward
 *   8. npm install (only if package-lock.json changed) + npm run build
 *   9. Print old -> new commit hash
 *  10. Offer to restart Telegram connection (calls alduin telegram restart)
 *
 * Warning: always tracks upstream main. Feature branches (like user-flow-updates)
 * are NOT recommended for `alduin update` — it will fast-forward to origin/main.
 */

import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { confirm } from '@clack/prompts';

const GUARD = (v: unknown): unknown => {
  if (typeof v === 'symbol') {
    console.log('\nCancelled.');
    process.exit(0);
  }
  return v;
};

export async function handleUpdateCommand(_args: string[]): Promise<void> {
  const projectRoot = process.env['ALDUIN_PROJECT_ROOT'] ?? process.cwd();

  // 1. Verify git checkout
  if (!existsSync(path.join(projectRoot, '.git'))) {
    console.error(
      'alduin update requires a git checkout.\n' +
        'Re-clone from https://github.com/BasementAnon/alduin.git.'
    );
    process.exit(1);
  }

  const run = (cmd: string, opts?: { capture?: boolean }): string => {
    try {
      const result = execSync(cmd, {
        cwd: projectRoot,
        stdio: opts?.capture ? 'pipe' : 'inherit',
        encoding: 'utf-8',
      });
      return typeof result === 'string' ? result.trim() : '';
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      throw new Error(`Command failed: ${cmd}\n${msg}`);
    }
  };

  // 2. Reject dirty working tree (tracked changes only — ignores untracked files
  //    and lockfile churn from npm link so builds don't block the next update)
  const trackedDiff = run('git diff-index --name-only HEAD --', { capture: true });
  if (trackedDiff.trim().length > 0) {
    // Filter out package-lock.json if it's the only dirty file (npm link artefact)
    const dirtyFiles = trackedDiff.trim().split('\n').filter(Boolean);
    const meaningful = dirtyFiles.filter((f) => f !== 'package-lock.json');
    if (meaningful.length > 0) {
      console.error(
        'Working tree dirty — commit or stash before updating.\n\n' +
          dirtyFiles.join('\n')
      );
      process.exit(1);
    }
    // Only package-lock.json is dirty — restore it so the pull is clean
    run('git checkout -- package-lock.json');
  }

  // 3. Record current HEAD
  const headBefore = run('git rev-parse HEAD', { capture: true });
  console.log(`Current commit: ${headBefore.slice(0, 12)}`);

  // 4. Fetch
  console.log('\nFetching from origin...');
  try {
    run('git fetch --tags origin');
  } catch (e) {
    console.error(`Failed to fetch: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }

  // 5. Determine upstream
  let upstream = '@{u}';
  try {
    upstream = run('git rev-parse --abbrev-ref --symbolic-full-name @{u}', { capture: true });
  } catch {
    // No upstream configured — try origin/main as fallback
    upstream = 'origin/main';
    console.warn(`No upstream branch configured; defaulting to ${upstream}.`);
  }

  // Check if there are new commits
  let incomingLog = '';
  try {
    incomingLog = run(`git log --oneline HEAD..${upstream} | head -20`, { capture: true });
  } catch {
    incomingLog = '';
  }

  if (!incomingLog.trim()) {
    console.log('Already up to date.');
    process.exit(0);
  }

  // 6. Show incoming commits and confirm
  console.log(`\nIncoming commits from ${upstream}:\n${incomingLog}\n`);
  const proceed = GUARD(await confirm({
    message: `Apply ${incomingLog.split('\n').length} new commit(s)?`,
    initialValue: true,
  })) as boolean;

  if (!proceed) {
    console.log('Update cancelled.');
    process.exit(0);
  }

  // 7. Pull (fast-forward only)
  console.log('\nPulling...');
  try {
    run('git pull --ff-only');
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes('diverged') || msg.includes('not-fast-forward') || msg.includes('non-fast-forward')) {
      console.error(
        'Local commits diverged from upstream — resolve manually with git.\n' + msg
      );
    } else {
      console.error(`git pull failed: ${msg}`);
    }
    process.exit(1);
  }

  // 8. npm install (only if package-lock.json changed) + npm run build
  let lockChanged = false;
  try {
    const diffOutput = run(`git diff ${headBefore} HEAD -- package-lock.json`, { capture: true });
    lockChanged = diffOutput.trim().length > 0;
  } catch {
    lockChanged = false;
  }

  if (lockChanged) {
    console.log('\npackage-lock.json changed — running npm install...');
    run('npm install');
  }

  console.log('\nBuilding...');
  run('npm run build');

  // 9. Print old -> new
  const headAfter = run('git rev-parse HEAD', { capture: true });
  console.log(`\nUpdated: ${headBefore.slice(0, 12)} -> ${headAfter.slice(0, 12)}`);

  // 10. Offer Telegram restart
  let telegramEnabled = false;
  try {
    const configResult = await import('../config/loader.js').then((m) =>
      m.loadConfig('./config.yaml')
    );
    if (configResult.ok) {
      telegramEnabled = configResult.value.channels?.telegram?.enabled === true;
    }
  } catch {
    telegramEnabled = false;
  }

  if (telegramEnabled) {
    const doRestart = GUARD(await confirm({
      message: 'Restart the Telegram connection now?',
      initialValue: true,
    })) as boolean;

    if (doRestart) {
      const { handleTelegramCommand } = await import('./telegram.js');
      await handleTelegramCommand(['restart']);
    } else {
      console.log('Skipped — restart manually with: alduin telegram restart');
    }
  } else {
    console.log('\nDone. No Telegram channel configured — nothing to restart.');
  }
}
