import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { CredentialVault } from './vault.js';
import { migrateFromDotenv, MIGRATION_SCOPES } from './migrate.js';

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), 'alduin-migrate-'));
}

describe('migrateFromDotenv', () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
    dirs.length = 0;
  });

  it('imports known env keys from process.env into the vault', () => {
    const vault = new CredentialVault(':memory:', 'test-secret');

    const result = migrateFromDotenv(
      vault,
      null,
      { ANTHROPIC_API_KEY: 'sk-ant-test', OPENAI_API_KEY: 'sk-oai-test' }
    );

    expect(result.imported).toBe(2);
    expect(result.keys).toContain('ANTHROPIC_API_KEY');
    expect(result.keys).toContain('OPENAI_API_KEY');
    expect(vault.get(MIGRATION_SCOPES.ANTHROPIC_API_KEY)).toBe('sk-ant-test');
    expect(vault.get(MIGRATION_SCOPES.OPENAI_API_KEY)).toBe('sk-oai-test');
    vault.close();
  });

  it('imports secrets from a .env file when env vars are absent', () => {
    const dir = makeTempDir();
    dirs.push(dir);
    const dotenvPath = join(dir, '.env');
    writeFileSync(
      dotenvPath,
      [
        '# comment',
        'ANTHROPIC_API_KEY=sk-from-file',
        'TELEGRAM_BOT_TOKEN=tg-token',
      ].join('\n'),
      'utf-8'
    );

    const vault = new CredentialVault(':memory:', 'test-secret');
    const result = migrateFromDotenv(vault, dotenvPath, {});

    expect(result.imported).toBe(2);
    expect(vault.get(MIGRATION_SCOPES.ANTHROPIC_API_KEY)).toBe('sk-from-file');
    expect(vault.get(MIGRATION_SCOPES.TELEGRAM_BOT_TOKEN)).toBe('tg-token');
    vault.close();
  });

  it('process.env values take precedence over .env file values', () => {
    const dir = makeTempDir();
    dirs.push(dir);
    const dotenvPath = join(dir, '.env');
    writeFileSync(dotenvPath, 'ANTHROPIC_API_KEY=sk-from-file', 'utf-8');

    const vault = new CredentialVault(':memory:', 'test-secret');
    migrateFromDotenv(vault, dotenvPath, { ANTHROPIC_API_KEY: 'sk-from-env' });

    expect(vault.get(MIGRATION_SCOPES.ANTHROPIC_API_KEY)).toBe('sk-from-env');
    vault.close();
  });

  it('is idempotent — skips scopes that already exist in the vault', () => {
    const vault = new CredentialVault(':memory:', 'test-secret');
    vault.set(MIGRATION_SCOPES.ANTHROPIC_API_KEY, 'existing-key');

    const result = migrateFromDotenv(
      vault,
      null,
      { ANTHROPIC_API_KEY: 'new-key' }
    );

    expect(result.skipped).toContain('ANTHROPIC_API_KEY');
    expect(result.imported).toBe(0);
    // Vault value is unchanged
    expect(vault.get(MIGRATION_SCOPES.ANTHROPIC_API_KEY)).toBe('existing-key');
    vault.close();
  });

  it('reports missing keys when neither env nor .env file has them', () => {
    const vault = new CredentialVault(':memory:', 'test-secret');
    const result = migrateFromDotenv(vault, null, {});

    expect(result.missing).toContain('ANTHROPIC_API_KEY');
    expect(result.missing).toContain('OPENAI_API_KEY');
    expect(result.imported).toBe(0);
    vault.close();
  });

  it('gracefully proceeds when the .env file does not exist', () => {
    const vault = new CredentialVault(':memory:', 'test-secret');
    const result = migrateFromDotenv(
      vault,
      '/nonexistent/.env',
      { ANTHROPIC_API_KEY: 'sk-from-env-only' }
    );

    expect(result.imported).toBe(1);
    expect(vault.get(MIGRATION_SCOPES.ANTHROPIC_API_KEY)).toBe('sk-from-env-only');
    vault.close();
  });

  it('handles quoted values in .env files', () => {
    const dir = makeTempDir();
    dirs.push(dir);
    const dotenvPath = join(dir, '.env');
    writeFileSync(
      dotenvPath,
      [
        'ANTHROPIC_API_KEY="sk-double-quoted"',
        "OPENAI_API_KEY='sk-single-quoted'",
      ].join('\n'),
      'utf-8'
    );

    const vault = new CredentialVault(':memory:', 'test-secret');
    migrateFromDotenv(vault, dotenvPath, {});

    expect(vault.get(MIGRATION_SCOPES.ANTHROPIC_API_KEY)).toBe('sk-double-quoted');
    expect(vault.get(MIGRATION_SCOPES.OPENAI_API_KEY)).toBe('sk-single-quoted');
    vault.close();
  });
});
