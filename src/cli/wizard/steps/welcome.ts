/**
 * Step 1 — Welcome + mode selection.
 *
 * Displays Alduin version and description. Asks whether this is a fresh
 * install or a reconfiguration of an existing setup.
 */

import { confirm, intro, log, select } from '@clack/prompts';
import { existsSync, readFileSync } from 'node:fs';
import { guard } from '../helpers.js';
import type { WelcomeAnswers, WizardMode } from '../types.js';

/**
 * Try to read the version from package.json.
 */
function getVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync('package.json', 'utf-8')) as { version?: string };
    return pkg.version ?? 'dev';
  } catch {
    return 'dev';
  }
}

export async function runWelcome(configPath: string): Promise<WelcomeAnswers> {
  const version = getVersion();
  intro(`Alduin v${version} — Multi-model AI agent orchestrator`);

  if (!existsSync(configPath)) {
    log.info('No existing configuration found. Starting fresh setup.');
    return { mode: 'fresh' };
  }

  const mode = guard(
    await select<WizardMode>({
      message: 'An existing config.yaml was found. What would you like to do?',
      options: [
        {
          label: 'Overwrite — start fresh, replacing the current config',
          value: 'overwrite',
        },
        {
          label: 'Reconfigure — walk through each section, keeping current values as defaults',
          value: 'reconfigure',
        },
      ],
    })
  );

  if (mode === 'overwrite') {
    const confirmed = guard(
      await confirm({
        message: 'This will overwrite your existing config.yaml. Continue?',
        initialValue: false,
      })
    );
    if (!confirmed) {
      log.info('Keeping existing config. Run `alduin init` again to reconfigure.');
      process.exit(0);
    }
  }

  return { mode };
}
