import { log, select } from '@clack/prompts';
import type { ChannelsConfig, TelegramChannelConfig } from '../../../config/schema/index.js';
import { guard } from '../helpers.js';
import type { ChannelAnswers } from '../types.js';

// ── Pure builder (tested) ─────────────────────────────────────────────────────

/**
 * Build the `channels` section of AlduinConfig from wizard answers.
 *
 * Legacy builder — kept for backward compatibility. Webhook mode is no longer
 * supported, so this always emits `mode: 'longpoll'` regardless of the input.
 * Webhook-related fields (webhook_url, webhook_secret_env) are only set when
 * the caller explicitly passes mode: 'webhook' (legacy data paths).
 *
 * @param answers - Channel, mode, and optional webhook URL from the wizard.
 * @returns Partial channels config ready to merge into the root config.
 */
export function buildChannelConfig(answers: ChannelAnswers): ChannelsConfig {
  if (answers.channel === 'cli') {
    return {};
  }

  const telegram: TelegramChannelConfig = {
    enabled: true,
    mode: 'longpoll',
    token_env: 'TELEGRAM_BOT_TOKEN',
  };

  if (answers.mode === 'webhook') {
    const base = answers.webhookUrl ?? '';
    // Normalise trailing slash and append path
    telegram.webhook_url = base.replace(/\/$/, '') + '/webhooks/telegram';
    telegram.webhook_secret_env = 'ALDUIN_WEBHOOK_SECRET';
  }

  return { telegram };
}

// ── UI (not tested directly) ──────────────────────────────────────────────────

/**
 * Step 1 — prompt the user to choose a channel and deployment mode.
 * Throws WizardCancelledError on Ctrl-C.
 */
export async function runPickChannel(): Promise<ChannelAnswers> {
  const channel = guard(
    await select<'telegram' | 'cli'>({
      message: 'Primary channel:',
      options: [
        { label: 'Telegram', value: 'telegram', hint: 'bot token from @BotFather' },
        { label: 'CLI only', value: 'cli', hint: 'no external channel (dev / testing)' },
      ],
    })
  );

  if (channel === 'cli') {
    log.info('CLI-only mode — no external channel will be configured.');
    return { channel: 'cli', mode: 'longpoll' };
  }

  // Webhook mode was removed — long-poll is the only supported mode.
  const mode = 'longpoll' as const;

  return { channel, mode };
}
