/**
 * Telegram channel adapter.
 *
 * We use grammY (https://grammy.dev) rather than node-telegram-bot-api because:
 * - TypeScript-first: full Update/Message types with no @types companion needed.
 * - Supports both webhook and long-poll with the same Bot instance.
 * - Active maintenance, middleware ecosystem, and clean async API.
 * - Webhook mode: grammY provides `webhookCallback(bot, 'express')` that mounts
 *   on any framework — the gateway mounts it under POST /webhooks/telegram.
 * - Long-poll mode: `bot.start()` handles getUpdates internally.
 */

import { timingSafeEqual } from 'node:crypto';
import { Bot, webhookCallback } from 'grammy';
import type { Update } from 'grammy/types';
import type { RequestHandler } from 'express';
import type {
  ChannelAdapter,
  ChannelCapabilities,
  PresentationPayload,
  ChannelTarget,
  SentMessageRef,
  RawChannelEvent,
} from '../adapter.js';
import { TELEGRAM_CAPABILITIES } from './capabilities.js';
import { parseUpdate } from './parse.js';

export interface TelegramAdapterConfig {
  mode: 'webhook' | 'longpoll';
  /** Bot token — read from env at construction time */
  token: string;
  /** Webhook URL (required for webhook mode) */
  webhook_url?: string;
  /** Secret token for webhook signature validation */
  webhook_secret?: string;
}

export class TelegramAdapter implements ChannelAdapter {
  readonly id = 'telegram';
  readonly capabilities: ChannelCapabilities = TELEGRAM_CAPABILITIES;

  private bot: Bot;
  private config: TelegramAdapterConfig;
  private eventHandler: ((event: RawChannelEvent) => void) | null = null;

  constructor(config: TelegramAdapterConfig) {
    this.config = config;
    this.bot = new Bot(config.token);

    // Wire all updates through our normalizer
    // grammy v1 uses middleware, not event emitter — handle all message types
    this.bot.use((ctx) => {
      if (!this.eventHandler) return;
      const raw: RawChannelEvent = {
        channel: 'telegram',
        received_at: new Date().toISOString(),
        payload: ctx.update,
      };
      this.eventHandler(raw);
    });
  }

  onEvent(handler: (event: RawChannelEvent) => void): void {
    this.eventHandler = handler;
  }

  async start(): Promise<void> {
    if (this.config.mode === 'longpoll') {
      // Delete any existing webhook so getUpdates works
      await this.bot.api.deleteWebhook();
      // bot.start() runs the getUpdates loop; don't await — it runs forever
      void this.bot.start({
        onStart: (info) =>
          console.log(`[Telegram] Long-poll started as @${info.username}`),
      });
    } else {
      // Webhook mode: set the webhook URL with optional secret
      const url = this.config.webhook_url;
      if (!url) {
        throw new Error('[Telegram] webhook_url is required in webhook mode');
      }
      await this.bot.api.setWebhook(url, {
        secret_token: this.config.webhook_secret,
      });
      console.log(`[Telegram] Webhook registered at ${url}`);
    }
  }

  async stop(): Promise<void> {
    if (this.config.mode === 'longpoll') {
      await this.bot.stop();
    } else {
      await this.bot.api.deleteWebhook();
    }
  }

  async send(
    payload: PresentationPayload,
    target: ChannelTarget
  ): Promise<SentMessageRef> {
    const sent = await this.bot.api.sendMessage(target.thread_id, payload.text, {
      parse_mode: payload.parse_mode === 'html' ? 'HTML' : undefined,
    });
    return {
      message_id: String(sent.message_id),
      channel: 'telegram',
      thread_id: target.thread_id,
    };
  }

  async edit(ref: SentMessageRef, payload: PresentationPayload): Promise<void> {
    await this.bot.api.editMessageText(
      ref.thread_id,
      parseInt(ref.message_id, 10),
      payload.text,
      { parse_mode: payload.parse_mode === 'html' ? 'HTML' : undefined }
    );
  }

  /**
   * Returns an Express request handler for webhook mode.
   * Mount this on POST /webhooks/telegram in the gateway.
   */
  getWebhookHandler(): RequestHandler {
    return webhookCallback(this.bot, 'express');
  }

  /**
   * Verify a Telegram webhook request's secret_token header.
   * Uses crypto.timingSafeEqual to prevent timing side-channel attacks.
   * The expected secret is read from the adapter's config (set at construction
   * from vault or env), not from process.env at call time.
   */
  verifyWebhookSignature(
    headers: Record<string, string | string[] | undefined>,
    _body?: Buffer
  ): boolean {
    const expectedSecret = this.config.webhook_secret;
    if (!expectedSecret) {
      // No secret configured — fail closed (the gateway decides whether to
      // allow unsigned requests based on ALDUIN_ALLOW_UNSIGNED / NODE_ENV)
      return false;
    }

    const headerValue = headers['x-telegram-bot-api-secret-token'];
    const received = typeof headerValue === 'string' ? headerValue : '';

    if (received.length === 0) return false;

    const expectedBuf = Buffer.from(expectedSecret, 'utf8');
    const receivedBuf = Buffer.from(received, 'utf8');

    // timingSafeEqual requires equal-length buffers; unequal length → reject
    if (expectedBuf.length !== receivedBuf.length) return false;

    return timingSafeEqual(expectedBuf, receivedBuf);
  }

  /** Parse a raw Update payload into a NormalizedEvent (exposed for testing) */
  parseUpdate(update: Update) {
    return parseUpdate(update);
  }

  /**
   * Prevent token leakage via JSON.stringify, structured logging, or console.log.
   * Returns a config copy with the bot token and webhook secret redacted.
   */
  toJSON(): Record<string, unknown> {
    return {
      id: this.id,
      config: {
        mode: this.config.mode,
        token: '[REDACTED]',
        webhook_url: this.config.webhook_url,
        webhook_secret: this.config.webhook_secret ? '[REDACTED]' : undefined,
      },
    };
  }
}
