import { log, select, text } from '@clack/prompts';
import type { ChannelsConfig, TelegramChannelConfig } from '../../../config/schema/index.js';
import { guard } from '../helpers.js';
import type { ChannelAnswers } from '../types.js';

// ── Pure builder (tested) ─────────────────────────────────────────────────────

/**
 * Build the `channels` section of AlduinConfig from wizard answers.
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
    mode: answers.mode,
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

  const mode = guard(
    await select<'longpoll' | 'webhook'>({
      message: 'Deployment mode:',
      options: [
        {
          label: 'Long-poll',
          value: 'longpoll',
          hint: 'dev / behind NAT — no public URL needed',
        },
        {
          label: 'Webhook',
          value: 'webhook',
          hint: 'prod — requires a reachable public HTTPS URL',
        },
      ],
    })
  );

  let webhookUrl: string | undefined;
  if (mode === 'webhook') {
    webhookUrl = guard(
      await text({
        message: 'Public webhook base URL:',
        placeholder: 'https://bot.example.com',
        validate: (v) => {
          if (!v || !v.startsWith('https://')) return 'URL must start with https://';
          return undefined;
        },
      })
    );
  }

  return { channel, mode, webhookUrl };
}
