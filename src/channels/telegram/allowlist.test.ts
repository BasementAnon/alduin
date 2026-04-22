/**
 * Tests for the Telegram adapter's allowed_user_ids allowlist feature.
 *
 * Verifies that:
 *  - Messages from an allowed user ID reach the event handler.
 *  - Messages from a non-allowed user ID are silently dropped (handler never called).
 *  - When allowed_user_ids is omitted or empty, all messages pass through (backward compat).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Update, UserFromGetMe } from 'grammy/types';
import { TelegramAdapter } from './index.js';
import type { RawChannelEvent } from '../adapter.js';

// Fake but structurally valid bot token — grammy validates format only on API calls.
const FAKE_TOKEN = '123456789:ABCdefGHIjklMNOpqrSTUvwxYZ0123456789';

// Pre-set bot identity so handleUpdate skips the getMe network round-trip.
const FAKE_BOT_INFO: UserFromGetMe = {
  id: 123456789,
  is_bot: true,
  first_name: 'TestBot',
  username: 'testbot',
  can_join_groups: false,
  can_read_all_group_messages: false,
  supports_inline_queries: false,
};

// ── Fixtures ──────────────────────────────────────────────────────────────────

function makeTextUpdate(userId: number, chatId?: number): Update {
  const chat = chatId ?? userId;
  return {
    update_id: 100000001,
    message: {
      message_id: 42,
      from: { id: userId, is_bot: false, first_name: 'TestUser' },
      chat: { id: chat, type: 'private', first_name: 'TestUser' },
      date: 1700000000,
      text: 'Hello',
    },
  } as unknown as Update;
}

function makeCallbackUpdate(userId: number): Update {
  return {
    update_id: 100000002,
    callback_query: {
      id: 'cbq-test-1',
      from: { id: userId, is_bot: false, first_name: 'TestUser' },
      message: {
        message_id: 55,
        chat: { id: userId, type: 'private', first_name: 'TestUser' },
        date: 1700000000,
        text: 'Choose',
      },
      data: 'action:confirm',
      chat_instance: 'ci-test',
    },
  } as unknown as Update;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeAdapter(allowedUserIds?: number[]): TelegramAdapter {
  return new TelegramAdapter({
    mode: 'longpoll',
    token: FAKE_TOKEN,
    _botInfo: FAKE_BOT_INFO,
    ...(allowedUserIds !== undefined ? { allowed_user_ids: allowedUserIds } : {}),
  });
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('TelegramAdapter — allowed_user_ids allowlist', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── Allowed user passes through ───────────────────────────────────────────

  it('delivers a message from an allowed user ID to the event handler', async () => {
    const adapter = makeAdapter([111222333, 987654321]);
    const handler = vi.fn<[RawChannelEvent], void>();
    adapter.onEvent(handler);

    await adapter.handleUpdateForTest(makeTextUpdate(111222333));

    expect(handler).toHaveBeenCalledOnce();
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('delivers a message from a second allowed user ID to the event handler', async () => {
    const adapter = makeAdapter([111222333, 987654321]);
    const handler = vi.fn<[RawChannelEvent], void>();
    adapter.onEvent(handler);

    await adapter.handleUpdateForTest(makeTextUpdate(987654321));

    expect(handler).toHaveBeenCalledOnce();
    expect(warnSpy).not.toHaveBeenCalled();
  });

  // ── Rejected user is dropped ──────────────────────────────────────────────

  it('drops a message from a non-allowed user ID without calling the event handler', async () => {
    const adapter = makeAdapter([111222333]);
    const handler = vi.fn<[RawChannelEvent], void>();
    adapter.onEvent(handler);

    await adapter.handleUpdateForTest(makeTextUpdate(999888777));

    expect(handler).not.toHaveBeenCalled();
  });

  it('logs a warn-level message when a user is rejected', async () => {
    const adapter = makeAdapter([111222333]);
    const handler = vi.fn<[RawChannelEvent], void>();
    adapter.onEvent(handler);

    await adapter.handleUpdateForTest(makeTextUpdate(999888777));

    expect(warnSpy).toHaveBeenCalledOnce();
    const warnArg: string = warnSpy.mock.calls[0]![0] as string;
    expect(warnArg).toContain('999888777');
    expect(warnArg).toMatch(/unauthorized/i);
  });

  it('drops a callback_query from a non-allowed user ID', async () => {
    const adapter = makeAdapter([111222333]);
    const handler = vi.fn<[RawChannelEvent], void>();
    adapter.onEvent(handler);

    await adapter.handleUpdateForTest(makeCallbackUpdate(999888777));

    expect(handler).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledOnce();
  });

  it('allows multiple messages from the same allowed user', async () => {
    const adapter = makeAdapter([111222333]);
    const handler = vi.fn<[RawChannelEvent], void>();
    adapter.onEvent(handler);

    await adapter.handleUpdateForTest(makeTextUpdate(111222333));
    await adapter.handleUpdateForTest(makeTextUpdate(111222333));

    expect(handler).toHaveBeenCalledTimes(2);
  });

  // ── Backward compatibility: omitted or empty list ─────────────────────────

  it('allows all users when allowed_user_ids is omitted', async () => {
    const adapter = makeAdapter(/* no allowedUserIds */);
    const handler = vi.fn<[RawChannelEvent], void>();
    adapter.onEvent(handler);

    await adapter.handleUpdateForTest(makeTextUpdate(999888777));
    await adapter.handleUpdateForTest(makeTextUpdate(111222333));

    expect(handler).toHaveBeenCalledTimes(2);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('allows all users when allowed_user_ids is an empty array', async () => {
    const adapter = makeAdapter([]);
    const handler = vi.fn<[RawChannelEvent], void>();
    adapter.onEvent(handler);

    await adapter.handleUpdateForTest(makeTextUpdate(999888777));
    await adapter.handleUpdateForTest(makeTextUpdate(42));

    expect(handler).toHaveBeenCalledTimes(2);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  // ── Mixed traffic: allowed and rejected interleaved ───────────────────────

  it('correctly filters mixed traffic — allows only listed IDs', async () => {
    const adapter = makeAdapter([111222333]);
    const handler = vi.fn<[RawChannelEvent], void>();
    adapter.onEvent(handler);

    await adapter.handleUpdateForTest(makeTextUpdate(111222333)); // allowed
    await adapter.handleUpdateForTest(makeTextUpdate(999888777)); // rejected
    await adapter.handleUpdateForTest(makeTextUpdate(111222333)); // allowed
    await adapter.handleUpdateForTest(makeTextUpdate(555444333)); // rejected

    expect(handler).toHaveBeenCalledTimes(2);
    expect(warnSpy).toHaveBeenCalledTimes(2);
  });
});
