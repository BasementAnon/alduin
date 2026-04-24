/**
 * Step 5 — Channel setup.
 *
 * Replaces the old pick-channel + paste-tokens two-step flow with a single
 * unified step that:
 *   - Asks CLI / Telegram / Both
 *   - Collects and validates Telegram bot token (format + getMe API call)
 *   - Asks longpoll vs webhook (with webhook URL + auto-generated secret)
 *   - Asks about user ID allowlisting for security
 *   - Shows BotFather security recommendations
 *   - Writes validated tokens to vault immediately
 */

import { confirm, log, multiselect, note, password, select, spinner, text } from '@clack/prompts';
import { randomBytes } from 'node:crypto';
import type { CredentialVault } from '../../../secrets/vault.js';
import type { ChannelsConfig, TelegramChannelConfig } from '../../../config/schema/index.js';
import { guard } from '../helpers.js';
import { trackVaultScope } from './providers.js';
import type { ChannelAnswers } from '../types.js';

// ── Vault scope keys ──────────────────────────────────────────────────────────

export const VAULT_SCOPE_TELEGRAM_TOKEN = 'channels/telegram/bot_token';
export const VAULT_SCOPE_TELEGRAM_WEBHOOK_SECRET = 'channels/telegram/webhook_secret';

// ── Token validation ──────────────────────────────────────────────────────────

const TELEGRAM_TOKEN_REGEX = /^\d+:[A-Za-z0-9_-]+$/;

function validateTelegramTokenFormat(token: string): string | undefined {
  if (!TELEGRAM_TOKEN_REGEX.test(token)) {
    return 'Telegram bot tokens look like "123456789:ABCdef..." (digits, colon, alphanumeric)';
  }
  return undefined;
}

/** Call Telegram's getMe API to validate the token. Returns bot username on success. */
async function testTelegramToken(
  token: string
): Promise<{ ok: true; username: string } | { ok: false; error: string }> {
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/getMe`, {
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { description?: string };
      return { ok: false, error: body.description ?? `HTTP ${res.status}` };
    }
    const data = (await res.json()) as {
      ok: boolean;
      result?: { username?: string };
    };
    if (!data.ok || !data.result?.username) {
      return { ok: false, error: 'Unexpected response from Telegram API' };
    }
    return { ok: true, username: data.result.username };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

// ── Pure builder (tested) ─────────────────────────────────────────────────────

export function buildChannelConfig(answers: ChannelAnswers): ChannelsConfig {
  if (answers.channel === 'cli') {
    return {};
  }

  const telegram: TelegramChannelConfig = {
    enabled: true,
    mode: answers.mode,
    token_env: 'TELEGRAM_BOT_TOKEN',
  };

  if (answers.mode === 'webhook') {
    const base = answers.webhookUrl ?? '';
    telegram.webhook_url = base.replace(/\/$/, '') + '/webhooks/telegram';
    telegram.webhook_secret_env = 'ALDUIN_WEBHOOK_SECRET';
  }

  if (answers.allowedUserIds && answers.allowedUserIds.length > 0) {
    telegram.allowed_user_ids = answers.allowedUserIds;
  }

  return { telegram };
}

// ── Vault writes ──────────────────────────────────────────────────────────────

export function writeChannelTokensToVault(
  vault: CredentialVault,
  answers: ChannelAnswers
): void {
  if (answers.channel === 'cli') return;

  vault.transaction(() => {
    if (answers.botToken) {
      vault.set(VAULT_SCOPE_TELEGRAM_TOKEN, answers.botToken);
    }
    if (answers.webhookSecret) {
      vault.set(VAULT_SCOPE_TELEGRAM_WEBHOOK_SECRET, answers.webhookSecret);
    }
  });
}

// ── UI ────────────────────────────────────────────────────────────────────────

export async function runChannelSetup(vault: CredentialVault): Promise<ChannelAnswers> {
  const channelChoice = guard(
    await select<'telegram' | 'cli' | 'both'>({
      message: 'How will you interact with Alduin?',
      options: [
        { label: 'CLI only', value: 'cli', hint: 'no external channel (dev / testing)' },
        { label: 'Telegram', value: 'telegram', hint: 'bot via @BotFather' },
        { label: 'Both (CLI + Telegram)', value: 'both', hint: 'Telegram bot + local CLI' },
      ],
    })
  );

  if (channelChoice === 'cli') {
    log.info('CLI-only mode — no external channel will be configured.');
    return { channel: 'cli', mode: 'longpoll' };
  }

  // Telegram setup (covers 'telegram' and 'both')
  const answers: ChannelAnswers = {
    channel: channelChoice,
    mode: 'longpoll',
  };

  // Collect bot token
  let validToken = false;
  while (!validToken) {
    const rawToken = guard(
      await password({
        message: 'Telegram bot token (from @BotFather):',
        mask: '*',
        validate: (v) => {
          if (!v || v.trim().length === 0) return 'Bot token is required';
          return validateTelegramTokenFormat(v.trim());
        },
      })
    );
    answers.botToken = rawToken.trim();

    // Test token with getMe
    const s = spinner();
    s.start('Validating Telegram bot token…');
    const result = await testTelegramToken(answers.botToken);

    if (result.ok) {
      answers.botUsername = result.username;
      s.stop(`Token valid — bot username: @${result.username}`);
      validToken = true;

      // Write to vault immediately (tracked for Ctrl-C cleanup)
      vault.set(VAULT_SCOPE_TELEGRAM_TOKEN, answers.botToken);
      trackVaultScope(VAULT_SCOPE_TELEGRAM_TOKEN);
    } else {
      s.stop(`Token validation failed: ${result.error}`);
      const retry = guard(
        await confirm({
          message: 'Re-enter the token?',
          initialValue: true,
        })
      );
      if (!retry) {
        log.warn('Continuing with unvalidated token. Telegram may not work.');
        vault.set(VAULT_SCOPE_TELEGRAM_TOKEN, answers.botToken);
        trackVaultScope(VAULT_SCOPE_TELEGRAM_TOKEN);
        validToken = true;
      }
    }
  }

  // Deployment mode
  answers.mode = guard(
    await select<'longpoll' | 'webhook'>({
      message: 'Deployment mode:',
      options: [
        {
          label: 'Long-poll (development)',
          value: 'longpoll',
          hint: 'no public URL needed — great for local dev',
        },
        {
          label: 'Webhook (production)',
          value: 'webhook',
          hint: 'requires a reachable public HTTPS URL',
        },
      ],
    })
  );

  if (answers.mode === 'webhook') {
    answers.webhookUrl = guard(
      await text({
        message: 'Public webhook base URL:',
        placeholder: 'https://bot.example.com',
        validate: (v) => {
          if (!v || !v.startsWith('https://')) return 'URL must start with https://';
          return undefined;
        },
      })
    );

    // Auto-generate webhook secret
    const autoGenerate = guard(
      await confirm({
        message: 'Auto-generate a webhook secret? (recommended)',
        initialValue: true,
      })
    );

    if (autoGenerate) {
      answers.webhookSecret = randomBytes(32).toString('hex');
      log.success('Webhook secret auto-generated (will be stored in vault).');
    } else {
      const customSecret = guard(
        await password({
          message: 'Custom webhook secret:',
          mask: '*',
          validate: (v) => {
            if (!v || v.trim().length < 16) return 'Secret must be at least 16 characters';
            return undefined;
          },
        })
      );
      answers.webhookSecret = customSecret.trim();
    }

    // Write webhook secret to vault (tracked for Ctrl-C cleanup)
    vault.set(VAULT_SCOPE_TELEGRAM_WEBHOOK_SECRET, answers.webhookSecret);
    trackVaultScope(VAULT_SCOPE_TELEGRAM_WEBHOOK_SECRET);
  }

  // Security: allowed_user_ids
  const restrictUsers = guard(
    await confirm({
      message: 'Restrict which Telegram users can interact with the bot? (recommended)',
      initialValue: true,
    })
  );

  if (restrictUsers) {
    const rawIds = guard(
      await text({
        message:
          'Comma-separated Telegram user IDs (find yours via @userinfobot on Telegram):',
        placeholder: '123456789, 987654321',
        validate: (v) => {
          if (!v || v.trim().length === 0) return 'At least one user ID is required';
          const parts = v.split(',').map((s) => s.trim());
          for (const part of parts) {
            if (!/^\d+$/.test(part)) return `"${part}" is not a valid numeric user ID`;
          }
          return undefined;
        },
      })
    );

    answers.allowedUserIds = rawIds
      .split(',')
      .map((s) => parseInt(s.trim(), 10))
      .filter((n) => !isNaN(n));

    log.success(
      `Access restricted to ${answers.allowedUserIds.length} user(s): ${answers.allowedUserIds.join(', ')}`
    );
  }

  // BotFather security recommendations
  note(
    'For maximum security, configure these in @BotFather:\n\n' +
      '  1. Disable group joins:  send /setjoingroups → Disable\n' +
      '  2. Enable group privacy: send /setprivacy    → Enable\n\n' +
      'This prevents your bot from being added to groups and\n' +
      'ensures it only receives messages directed at it.',
    'BotFather Security Checklist'
  );

  // .env writes are deferred to the final commit step (wizard/index.ts step 9)

  return answers;
}
