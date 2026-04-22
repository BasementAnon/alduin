import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { CredentialVault } from './vault.js';

/** Vault scope keys used for each well-known secret. */
export const MIGRATION_SCOPES = {
  ANTHROPIC_API_KEY: 'providers/anthropic/api_key',
  OPENAI_API_KEY: 'providers/openai/api_key',
  DEEPSEEK_API_KEY: 'providers/deepseek/api_key',
  TELEGRAM_BOT_TOKEN: 'channels/telegram/bot_token',
  ALDUIN_WEBHOOK_SECRET: 'channels/telegram/webhook_secret',
} as const satisfies Record<string, string>;

export type MigrationEnvKey = keyof typeof MIGRATION_SCOPES;

export interface MigrationResult {
  /** Number of secrets written to the vault. */
  imported: number;
  /** Env keys that were found and migrated. */
  keys: MigrationEnvKey[];
  /** Env keys that were skipped because the vault scope already had a value. */
  skipped: MigrationEnvKey[];
  /** Env keys that were absent from both the .env file and process.env. */
  missing: MigrationEnvKey[];
}

/**
 * Parse a simple KEY=VALUE .env file.
 * Lines beginning with # and empty lines are ignored.
 * Values are unquoted (strips surrounding single or double quotes).
 */
function parseDotenv(content: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx < 1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    let val = trimmed.slice(eqIdx + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (key && val) result[key] = val;
  }
  return result;
}

/**
 * One-shot migration: import well-known secrets from a .env file (and/or
 * process.env) into the Alduin credential vault.
 *
 * Idempotent — already-present vault scopes are left unchanged and reported
 * in `result.skipped`.
 *
 * @param vault      The target CredentialVault (caller is responsible for
 *                   opening and closing it).
 * @param dotenvPath Path to the .env file. Defaults to `.env` in cwd.
 *                   Pass `null` to skip file reading and use only process.env.
 * @param env        Environment variables to consult (defaults to process.env).
 *                   Values from `env` take precedence over the .env file.
 */
export function migrateFromDotenv(
  vault: CredentialVault,
  dotenvPath: string | null = resolve(process.cwd(), '.env'),
  env: Record<string, string | undefined> = process.env as Record<string, string | undefined>
): MigrationResult {
  // Load .env file if it exists
  let fileEnv: Record<string, string> = {};
  if (dotenvPath !== null && existsSync(dotenvPath)) {
    try {
      const content = readFileSync(dotenvPath, 'utf-8');
      fileEnv = parseDotenv(content);
    } catch {
      // Non-fatal; proceed with process.env only
    }
  }

  const result: MigrationResult = {
    imported: 0,
    keys: [],
    skipped: [],
    missing: [],
  };

  for (const [envKey, scope] of Object.entries(MIGRATION_SCOPES) as [MigrationEnvKey, string][]) {
    // process.env / caller-supplied env takes precedence over .env file
    const value = env[envKey] ?? fileEnv[envKey];

    if (!value) {
      result.missing.push(envKey);
      continue;
    }

    if (vault.has(scope)) {
      result.skipped.push(envKey);
      continue;
    }

    vault.set(scope, value);
    result.imported++;
    result.keys.push(envKey);
  }

  return result;
}
