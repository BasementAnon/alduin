import type { ChannelCapabilities } from '../adapter.js';

/**
 * Telegram capability matrix.
 * Telegram supports in-place message edits, inline keyboards (buttons),
 * file sending, voice messages, and typing indicators.
 * It does NOT have threaded replies in the Slack/Discord sense.
 */
export const TELEGRAM_CAPABILITIES: ChannelCapabilities = {
  supports_edit: true,
  supports_buttons: true,
  supports_threads: false, // Telegram topics are not full threads
  supports_files: true,
  supports_voice: true,
  supports_typing_indicator: true,
  max_message_length: 4096,
  max_attachment_bytes: 20 * 1024 * 1024, // 20 MB for bots
  markdown_dialect: 'telegram-html',
};
