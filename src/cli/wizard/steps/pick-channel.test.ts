/**
 * Tests for the legacy pick-channel.ts builder (kept for historical
 * reference — the active wizard uses src/cli/wizard/steps/channel.ts).
 *
 * Note: the new channel.ts::buildChannelConfig always hard-codes longpoll
 * (webhook mode was removed from the user journey in plan item #5).
 */
import { describe, it, expect } from 'vitest';
import { buildChannelConfig } from './pick-channel.js';
import { buildChannelConfig as buildChannelConfigNew } from './channel.js';

describe('buildChannelConfig (legacy pick-channel.ts)', () => {
  it('returns empty object for CLI channel', () => {
    const result = buildChannelConfig({ channel: 'cli', mode: 'longpoll' });
    expect(result).toEqual({});
  });

  it('builds longpoll telegram config', () => {
    const result = buildChannelConfig({ channel: 'telegram', mode: 'longpoll' });
    expect(result).toEqual({
      telegram: {
        enabled: true,
        mode: 'longpoll',
        token_env: 'TELEGRAM_BOT_TOKEN',
      },
    });
  });

  it('builds webhook-origin config but forces longpoll mode (legacy only)', () => {
    const result = buildChannelConfig({
      channel: 'telegram',
      mode: 'webhook',
      webhookUrl: 'https://bot.example.com',
    });
    // Builder now always emits longpoll, but still sets webhook fields for legacy compat
    expect(result.telegram?.mode).toBe('longpoll');
    expect(result.telegram?.webhook_url).toBe('https://bot.example.com/webhooks/telegram');
    expect(result.telegram?.webhook_secret_env).toBe('ALDUIN_WEBHOOK_SECRET');
    expect(result.telegram?.token_env).toBe('TELEGRAM_BOT_TOKEN');
  });

  it('strips trailing slash from webhookUrl before appending path (legacy only)', () => {
    const result = buildChannelConfig({
      channel: 'telegram',
      mode: 'webhook',
      webhookUrl: 'https://bot.example.com/',
    });
    expect(result.telegram?.webhook_url).toBe('https://bot.example.com/webhooks/telegram');
  });

  it('does not set webhook fields in longpoll mode', () => {
    const result = buildChannelConfig({ channel: 'telegram', mode: 'longpoll' });
    expect(result.telegram?.webhook_url).toBeUndefined();
    expect(result.telegram?.webhook_secret_env).toBeUndefined();
  });

  it('always enables the telegram channel when channel is telegram', () => {
    const longpoll = buildChannelConfig({ channel: 'telegram', mode: 'longpoll' });
    const legacyWebhook = buildChannelConfig({
      channel: 'telegram',
      mode: 'webhook',
      webhookUrl: 'https://x.example.com',
    });
    expect(longpoll.telegram?.enabled).toBe(true);
    expect(legacyWebhook.telegram?.enabled).toBe(true);
  });
});

describe('buildChannelConfig (active channel.ts — long-poll only)', () => {
  it('returns empty object for CLI channel', () => {
    const result = buildChannelConfigNew({ channel: 'cli', mode: 'longpoll' });
    expect(result).toEqual({});
  });

  it('always hard-codes longpoll regardless of answers.mode', () => {
    const result = buildChannelConfigNew({ channel: 'telegram', mode: 'longpoll' });
    expect(result.telegram?.mode).toBe('longpoll');
  });

  it('never emits webhook_url or webhook_secret_env', () => {
    // Even if answers had mode: webhook (legacy data), builder ignores it
    const result = buildChannelConfigNew({
      channel: 'telegram',
      mode: 'webhook' as 'longpoll',
      webhookUrl: 'https://bot.example.com',
    });
    expect(result.telegram?.mode).toBe('longpoll');
    expect(result.telegram?.webhook_url).toBeUndefined();
    expect(result.telegram?.webhook_secret_env).toBeUndefined();
  });

  it('includes allowedUserIds when provided', () => {
    const result = buildChannelConfigNew({
      channel: 'telegram',
      mode: 'longpoll',
      allowedUserIds: [123456789],
    });
    expect(result.telegram?.allowed_user_ids).toEqual([123456789]);
  });
});
