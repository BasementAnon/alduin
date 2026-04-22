import { z } from 'zod';

export const telegramChannelConfigSchema = z.object({
  enabled: z.boolean(),
  mode: z.enum(['webhook', 'longpoll']),
  /** Name of the env var holding the bot token. */
  token_env: z.string().min(1),
  /** Webhook URL (required in webhook mode). */
  webhook_url: z.string().url().optional(),
  /** Name of the env var holding the webhook secret token. */
  webhook_secret_env: z.string().optional(),
  /**
   * Optional allowlist of Telegram numeric user IDs permitted to interact with
   * the bot. When omitted or empty, all users are allowed (open access).
   * Messages from any user not in this list are silently dropped before
   * reaching the orchestrator, session resolver, or any LLM call.
   */
  allowed_user_ids: z.array(z.number()).optional(),
});

/** Telegram channel configuration. */
export type TelegramChannelConfig = z.output<typeof telegramChannelConfigSchema>;

export const channelsConfigSchema = z.object({
  telegram: telegramChannelConfigSchema.optional(),
});

/** Channel configurations (Telegram, CLI, …). */
export type ChannelsConfig = z.output<typeof channelsConfigSchema>;
