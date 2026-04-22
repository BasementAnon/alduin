import { describe, it, expect } from 'vitest';
import {
  buildVaultEntries,
  VAULT_SCOPE_TELEGRAM_TOKEN,
  VAULT_SCOPE_TELEGRAM_WEBHOOK_SECRET,
} from './paste-tokens.js';
import { CredentialVault } from '../../../secrets/vault.js';
import { writeTokensToVault } from './paste-tokens.js';

describe('buildVaultEntries', () => {
  it('returns empty object for CLI channel', () => {
    const entries = buildVaultEntries(
      { channel: 'cli', mode: 'longpoll' },
      { botToken: 'irrelevant' }
    );
    expect(entries).toEqual({});
  });

  it('maps bot token to the correct vault scope', () => {
    const entries = buildVaultEntries(
      { channel: 'telegram', mode: 'longpoll' },
      { botToken: 'bot123:ABC' }
    );
    expect(entries[VAULT_SCOPE_TELEGRAM_TOKEN]).toBe('bot123:ABC');
    expect(Object.keys(entries)).toHaveLength(1);
  });

  it('includes webhook secret scope when mode is webhook', () => {
    const entries = buildVaultEntries(
      { channel: 'telegram', mode: 'webhook' },
      { botToken: 'bot456:XYZ', webhookSecret: 'aabbcc' }
    );
    expect(entries[VAULT_SCOPE_TELEGRAM_TOKEN]).toBe('bot456:XYZ');
    expect(entries[VAULT_SCOPE_TELEGRAM_WEBHOOK_SECRET]).toBe('aabbcc');
    expect(Object.keys(entries)).toHaveLength(2);
  });

  it('omits webhook secret scope in longpoll mode even if secret is provided', () => {
    const entries = buildVaultEntries(
      { channel: 'telegram', mode: 'longpoll' },
      { botToken: 'bot:T', webhookSecret: 'secret' }
    );
    expect(entries[VAULT_SCOPE_TELEGRAM_WEBHOOK_SECRET]).toBeUndefined();
  });

  it('omits bot token scope when botToken is undefined', () => {
    const entries = buildVaultEntries({ channel: 'telegram', mode: 'longpoll' }, {});
    expect(entries[VAULT_SCOPE_TELEGRAM_TOKEN]).toBeUndefined();
  });
});

describe('writeTokensToVault', () => {
  it('stores the bot token in the vault at the correct scope', () => {
    const vault = new CredentialVault(':memory:', 'test-master');
    writeTokensToVault(
      vault,
      { channel: 'telegram', mode: 'longpoll' },
      { botToken: 'tg-token-123' }
    );
    expect(vault.get(VAULT_SCOPE_TELEGRAM_TOKEN)).toBe('tg-token-123');
    vault.close();
  });

  it('stores webhook secret in the vault when mode is webhook', () => {
    const vault = new CredentialVault(':memory:', 'test-master');
    writeTokensToVault(
      vault,
      { channel: 'telegram', mode: 'webhook' },
      { botToken: 'tg-token', webhookSecret: 'wh-secret' }
    );
    expect(vault.get(VAULT_SCOPE_TELEGRAM_WEBHOOK_SECRET)).toBe('wh-secret');
    vault.close();
  });

  it('does not write anything to vault for CLI channel', () => {
    const vault = new CredentialVault(':memory:', 'test-master');
    writeTokensToVault(vault, { channel: 'cli', mode: 'longpoll' }, { botToken: 'irrelevant' });
    expect(vault.list('')).toHaveLength(0);
    vault.close();
  });
});
