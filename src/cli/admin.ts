/**
 * CLI handler for `alduin admin` subcommands.
 *
 *   alduin admin bootstrap --tenant <t> --user-id <u> [--config <path>]
 *
 * Seeds the first `owner` role for a tenant. Guarded so it cannot silently
 * replace an existing owner (H-10 fix).
 */

import { parseArgs } from 'node:util';
import { loadConfig } from '../config/loader.js';
import { openSqlite } from '../db/open.js';
import { bootstrapOwner, formatBootstrapError } from '../auth/bootstrap.js';

const DEFAULT_DB_PATH = '.alduin-sessions.db';

/**
 * Entry point for `alduin admin ...`. `subArgs` is the argv slice after the
 * `admin` subcommand token (i.e. everything after `alduin admin`).
 * `configPath` is the --config value already parsed by the top-level CLI.
 *
 * Exits the process with a non-zero code on any failure so scripted callers
 * can detect bootstrap attempts that were refused.
 */
export async function handleAdminCommand(
  subArgs: string[],
  configPath: string
): Promise<void> {
  const [subcommand, ...rest] = subArgs;

  switch (subcommand) {
    case 'bootstrap':
      await runBootstrap(rest, configPath);
      return;
    case undefined:
    case '--help':
    case '-h':
      printUsage();
      return;
    default:
      console.error(`Unknown admin subcommand: ${subcommand}`);
      printUsage();
      process.exit(1);
  }
}

function printUsage(): void {
  console.log(`Usage:
  alduin admin bootstrap --tenant <tenant> --user-id <channel-user-id> [--config <path>]

  Seed the first owner for a tenant. Refuses to run if an owner already exists.`);
}

async function runBootstrap(args: string[], configPath: string): Promise<void> {
  let parsed: { values: Record<string, unknown> };
  try {
    parsed = parseArgs({
      args,
      options: {
        tenant: { type: 'string' },
        'user-id': { type: 'string' },
        config: { type: 'string', short: 'c' },
      },
      strict: true,
    });
  } catch (e) {
    console.error(`admin bootstrap: ${e instanceof Error ? e.message : String(e)}`);
    printUsage();
    process.exit(1);
  }

  const tenantFlag = parsed.values['tenant'];
  const userIdFlag = parsed.values['user-id'];
  const configOverride = parsed.values['config'];

  if (typeof userIdFlag !== 'string' || userIdFlag.trim().length === 0) {
    console.error('admin bootstrap: --user-id is required');
    printUsage();
    process.exit(1);
  }

  // Resolve effective config path (bootstrap-level --config wins)
  const effectiveConfigPath =
    typeof configOverride === 'string' && configOverride.length > 0
      ? configOverride
      : configPath;

  // Resolve tenant: --tenant wins, otherwise config default, otherwise 'default'.
  let tenantId: string;
  if (typeof tenantFlag === 'string' && tenantFlag.trim().length > 0) {
    tenantId = tenantFlag.trim();
  } else {
    const cfg = loadConfig(effectiveConfigPath);
    if (!cfg.ok) {
      console.error(
        `admin bootstrap: --tenant not provided and could not load config ` +
          `(${effectiveConfigPath}): ${cfg.error.message}`
      );
      process.exit(1);
    }
    tenantId = cfg.value.tenants?.default_tenant_id ?? 'default';
  }

  const db = openSqlite(DEFAULT_DB_PATH);
  try {
    const result = bootstrapOwner(db, {
      tenantId,
      userId: userIdFlag.trim(),
    });

    if (!result.ok) {
      console.error(formatBootstrapError(result.error));
      process.exit(result.error.kind === 'owner_exists' ? 2 : 1);
    }

    console.log(
      `Owner set: tenant="${result.value.tenantId}" user_id="${result.value.userId}".`
    );
  } finally {
    db.close();
  }
}
