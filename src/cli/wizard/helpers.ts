import { isCancel, cancel, log } from '@clack/prompts';
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { WizardCancelledError } from './types.js';

/**
 * Wraps a @clack/prompts return value: throws WizardCancelledError when the
 * user presses Ctrl-C, otherwise returns the value unchanged.
 */
export function guard<T>(value: T | symbol): T {
  if (isCancel(value)) {
    cancel('Setup cancelled.');
    throw new WizardCancelledError();
  }
  return value as T;
}

/** Create a directory (and parents) if it does not already exist. */
export function ensureDir(dir: string): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

/**
 * Append or replace a KEY=VALUE line in .env.
 * Creates the file with 0600 permissions if it does not exist.
 */
export function writeEnvVar(key: string, value: string, envPath = '.env'): void {
  const entry = `${key}=${value}`;

  if (existsSync(envPath)) {
    const lines = readFileSync(envPath, 'utf-8').split('\n');
    const idx = lines.findIndex((l) => l.startsWith(`${key}=`));
    if (idx !== -1) {
      lines[idx] = entry;
      writeFileSync(envPath, lines.join('\n'), { encoding: 'utf-8', mode: 0o600 });
    } else {
      appendFileSync(envPath, `\n${entry}\n`, { encoding: 'utf-8', mode: 0o600 });
    }
  } else {
    writeFileSync(
      envPath,
      `# Alduin secrets — never commit this file\n${entry}\n`,
      { encoding: 'utf-8', mode: 0o600 }
    );
  }

  try {
    chmodSync(envPath, 0o600);
  } catch {
    // best-effort on Windows
  }
}

/**
 * Append a timestamped line to `.alduin/wizard-audit.log`.
 * Non-fatal: logs a warning if the write fails.
 */
export function appendWizardAuditEntry(entry: string): void {
  try {
    ensureDir('.alduin');
    const line = `[${new Date().toISOString()}] ${entry}\n`;
    appendFileSync('.alduin/wizard-audit.log', line, { encoding: 'utf-8', mode: 0o600 });
  } catch (e) {
    log.warn(`Could not write audit entry: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/**
 * Extract the provider prefix from a fully-qualified model string.
 * "anthropic/claude-sonnet-4-6" → "anthropic"
 */
export function providerOf(modelString: string): string {
  return modelString.split('/')[0] ?? modelString;
}
