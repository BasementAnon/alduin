import { describe, it, expect } from 'vitest';
import { buildChannelConfig } from './pick-channel.js';

describe('buildChannelConfig', () => {
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

  it('builds webhook telegram config with correct path appended', () => {
    const result = buildChannelConfig({
      channel: 'telegram',
      mode: 'webhook',
      webhookUrl: 'https://bot.example.com',
    });
    expect(result.telegram?.mode).toBe('webhook');
    expect(result.telegram?.webhook_url).toBe('https://bot.example.com/webhooks/telegram');
    expect(result.telegram?.webhook_secret_env).toBe('ALDUIN_WEBHOOK_SECRET');
    expect(result.telegram?.token_env).toBe('TELEGRAM_BOT_TOKEN');
  });

  it('strips trailing slash from webhookUrl before appending path', () => {
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
    const webhook = buildChannelConfig({
      channel: 'telegram',
      mode: 'webhook',
      webhookUrl: 'https://x.example.com',
    });
    expect(longpoll.telegram?.enabled).toBe(true);
    expect(webhook.telegram?.enabled).toBe(true);
  });
});
