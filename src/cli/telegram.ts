/**
 * alduin telegram <subcommand> — CLI commands for the Telegram channel.
 *
 * Verified: no `alduin telegram` CLI command existed before this commit.
 * The in-process TelegramAdapter has start()/stop() but no CLI hook called them.
 *
 * Subcommands:
 *   alduin telegram restart   — tear down current long-poll, clear stale
 *                               webhook (defensive), and restart the session
 */

import { loadConfig } from '../config/loader.js';
import { TelegramAdapter } from '../channels/telegram/index.js';

const CONFIG_PATH = './config.yaml';

export async function handleTelegramCommand(
  args: string[],
  configPath: string = CONFIG_PATH
): Promise<void> {
  const [sub] = args;

  if (sub !== 'restart') {
    console.error(`alduin telegram: unknown subcommand "${sub ?? ''}"`);
    console.error('Usage: alduin telegram restart');
    process.exit(1);
  }

  // Load config to get the bot token env var
  const configResult = loadConfig(configPath);
  if (!configResult.ok) {
    console.error(`[alduin telegram restart] Config error: ${configResult.error.message}`);
    process.exit(1);
  }
  const config = configResult.value;

  const telegramCfg = config.channels?.telegram;
  if (!telegramCfg?.enabled) {
    console.error('[alduin telegram restart] Telegram channel is not enabled in config.yaml.');
    process.exit(1);
  }

  const token = process.env[telegramCfg.token_env ?? 'TELEGRAM_BOT_TOKEN'];
  if (!token) {
    console.error(
      `[alduin telegram restart] Bot token env var "${telegramCfg.token_env}" is not set.`
    );
    process.exit(1);
  }

  console.log('[alduin telegram restart] Connecting to Telegram...');

  const adapter = new TelegramAdapter({
    mode: 'longpoll',
    token,
    allowed_user_ids: telegramCfg.allowed_user_ids,
  });

  try {
    const { botUsername } = await adapter.restart();
    console.log(`Telegram connection restarted (mode: longpoll, bot: @${botUsername})`);
    // Stop immediately — this is a one-shot CLI check, not a persistent process.
    // For a live restart of a running process, use the in-chat command instead.
    await adapter.stop();
    console.log('[alduin telegram restart] Done. The persistent Alduin process (if running) was not affected.');
    console.log('To restart the long-poll in a live process, use: /alduin telegram restart (in Telegram chat)');
  } catch (e) {
    console.error(`[alduin telegram restart] Failed: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }
}
