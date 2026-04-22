import { log, password } from '@clack/prompts';
import { randomBytes } from 'node:crypto';
import type { CredentialVault } from '../../../secrets/vault.js';
import { guard, writeEnvVar } from '../helpers.js';
import type { ChannelAnswers, TokenAnswers } from '../types.js';

// ── Vault scope keys ──────────────────────────────────────────────────────────

/** Canonical vault scope for the Telegram bot token. */
export const VAULT_SCOPE_TELEGRAM_TOKEN = 'channels/telegram/bot_token';
/** Canonical vault scope for the Telegram webhook HMAC secret. */
export const VAULT_SCOPE_TELEGRAM_WEBHOOK_SECRET = 'channels/telegram/webhook_secret';

// ── Pure builders (tested) ────────────────────────────────────────────────────

/**
 * Build the map of vault-scope → plaintext value entries to write.
 *
 * @param channel - Wizard channel answers (channel type and mode).
 * @param tokens  - Bot token and optional webhook secret from the wizard.
 * @returns Record of vault scope keys to plaintext values.
 */
export function buildVaultEntries(
  channel: ChannelAnswers,
  tokens: TokenAnswers
): Record<string, string> {
  const entries: Record<string, string> = {};

  if (channel.channel === 'telegram') {
    if (tokens.botToken) {
      entries[VAULT_SCOPE_TELEGRAM_TOKEN] = tokens.botToken;
    }
    if (channel.mode === 'webhook' && tokens.webhookSecret) {
      entries[VAULT_SCOPE_TELEGRAM_WEBHOOK_SECRET] = tokens.webhookSecret;
    }
  }

  return entries;
}

/**
 * Write vault entries and the corresponding env vars to disk.
 * Idempotent: existing vault scopes are overwritten, not duplicated.
 */
export function writeTokensToVault(
  vault: CredentialVault,
  channel: ChannelAnswers,
  tokens: TokenAnswers
): void {
  const entries = buildVaultEntries(channel, tokens);
  for (const [scope, value] of Object.entries(entries)) {
    vault.set(scope, value);
  }

  // Mirror tokens to .env so the runtime can load them via env var references
  if (tokens.botToken) {
    writeEnvVar('TELEGRAM_BOT_TOKEN', tokens.botToken);
  }
  if (tokens.webhookSecret) {
    writeEnvVar('ALDUIN_WEBHOOK_SECRET', tokens.webhookSecret);
  }
}

// ── UI (not tested directly) ──────────────────────────────────────────────────

/**
 * Step 2 — collect the bot token (and auto-generate a webhook secret when
 * needed). Tokens are NOT written to disk here; that happens in commit phase.
 * Throws WizardCancelledError on Ctrl-C.
 */
export async function runPasteTokens(channelAnswers: ChannelAnswers): Promise<TokenAnswers> {
  if (channelAnswers.channel === 'cli') {
    log.info('No tokens needed for CLI-only mode.');
    return {};
  }

  const rawToken = guard(
    await password({
      message: 'Telegram bot token (from @BotFather):',
      mask: '*',
    })
  );
  const botToken = rawToken.trim();

  let webhookSecret: string | undefined;
  if (channelAnswers.mode === 'webhook') {
    webhookSecret = randomBytes(32).toString('hex');
    log.success('Webhook secret auto-generated (stored in vault + .env as ALDUIN_WEBHOOK_SECRET).');
  }

  return { botToken, webhookSecret };
}
