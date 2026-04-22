import { describe, it, expect } from 'vitest';
import { parseUpdate } from './parse.js';
import type { Update } from 'grammy/types';

// ── Fixtures ──────────────────────────────────────────────────────────────────

function makeTextMessage(overrides: Record<string, unknown> = {}): Update {
  return {
    update_id: 100000001,
    message: {
      message_id: 42,
      from: { id: 111222333, is_bot: false, first_name: 'Alice', username: 'alicetg' },
      chat: { id: 111222333, type: 'private', first_name: 'Alice' },
      date: 1700000000,
      text: 'Hello Alduin',
      ...overrides,
    },
  } as unknown as Update;
}

function makeGroupMessage(): Update {
  return {
    update_id: 100000002,
    message: {
      message_id: 7,
      from: { id: 444555666, is_bot: false, first_name: 'Bob', username: 'bobtg' },
      chat: { id: -1001234567890, type: 'supergroup', title: 'Dev Group' },
      date: 1700000001,
      text: 'Hi everyone',
    },
  } as unknown as Update;
}

function makeEditedMessage(): Update {
  return {
    update_id: 100000003,
    edited_message: {
      message_id: 42,
      from: { id: 111222333, is_bot: false, first_name: 'Alice', username: 'alicetg' },
      chat: { id: 111222333, type: 'private', first_name: 'Alice' },
      date: 1700000000,
      edit_date: 1700000010,
      text: 'Hello Alduin (edited)',
    },
  } as unknown as Update;
}

function makeCallbackQuery(): Update {
  return {
    update_id: 100000004,
    callback_query: {
      id: 'cbq-abc123',
      from: { id: 111222333, is_bot: false, first_name: 'Alice', username: 'alicetg' },
      message: {
        message_id: 55,
        chat: { id: 111222333, type: 'private', first_name: 'Alice' },
        date: 1700000000,
        text: 'Choose an option',
      },
      data: 'option:A',
      chat_instance: 'ci-xyz',
    },
  } as unknown as Update;
}

function makePhotoMessage(): Update {
  return {
    update_id: 100000005,
    message: {
      message_id: 99,
      from: { id: 111222333, is_bot: false, first_name: 'Alice' },
      chat: { id: 111222333, type: 'private', first_name: 'Alice' },
      date: 1700000002,
      caption: 'Look at this!',
      photo: [
        { file_id: 'small-id', file_unique_id: 'su1', width: 90, height: 90, file_size: 1024 },
        { file_id: 'large-id', file_unique_id: 'su2', width: 800, height: 600, file_size: 51200 },
      ],
    },
  } as unknown as Update;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('parseUpdate (Telegram)', () => {
  it('parses a private text message', () => {
    const event = parseUpdate(makeTextMessage());
    expect(event).not.toBeNull();
    expect(event!.channel).toBe('telegram');
    expect(event!.kind).toBe('message');
    expect(event!.text).toBe('Hello Alduin');
    expect(event!.external.user_id).toBe('111222333');
    expect(event!.external.user_handle).toBe('alicetg');
    expect(event!.external.thread_id).toBe('111222333');
    expect(event!.external.is_group).toBe(false);
    expect(event!.external.message_id).toBe('42');
    expect(event!.event_id).toBe('tg-msg-42-111222333');
  });

  it('parses a group message and sets is_group=true', () => {
    const event = parseUpdate(makeGroupMessage());
    expect(event).not.toBeNull();
    expect(event!.external.is_group).toBe(true);
    expect(event!.external.thread_id).toBe('-1001234567890');
    expect(event!.external.user_handle).toBe('bobtg');
    expect(event!.text).toBe('Hi everyone');
  });

  it('parses an edited message with kind=edit and edit_of set', () => {
    const event = parseUpdate(makeEditedMessage());
    expect(event).not.toBeNull();
    expect(event!.kind).toBe('edit');
    expect(event!.external.edit_of).toBe('42');
    expect(event!.text).toBe('Hello Alduin (edited)');
  });

  it('parses a callback query with payload and origin_ref', () => {
    const event = parseUpdate(makeCallbackQuery());
    expect(event).not.toBeNull();
    expect(event!.kind).toBe('callback');
    expect(event!.callback).toBeDefined();
    expect(event!.callback!.payload).toBe('option:A');
    expect(event!.callback!.origin_ref.message_id).toBe('55');
    expect(event!.callback!.origin_ref.channel).toBe('telegram');
    expect(event!.event_id).toBe('tg-cbq-cbq-abc123');
  });

  it('parses a photo message with attachment stubs', () => {
    const event = parseUpdate(makePhotoMessage());
    expect(event).not.toBeNull();
    expect(event!.kind).toBe('file');
    expect(event!.text).toBe('Look at this!');
    expect(event!.attachments).toHaveLength(1);
    const att = event!.attachments![0]!;
    expect(att.kind).toBe('image');
    expect(att.mime).toBe('image/jpeg');
    // Should pick the largest photo (file_size 51200)
    expect(att.storage_uri).toContain('large-id');
    expect(att.bytes).toBe(51200);
    expect(att.ttl_expires_at).toBeTruthy();
  });

  it('returns null for unknown update types', () => {
    const empty = { update_id: 999 } as Update;
    expect(parseUpdate(empty)).toBeNull();
  });

  it('attaches the raw update as raw field', () => {
    const raw = makeTextMessage();
    const event = parseUpdate(raw);
    expect(event!.raw).toBe(raw.message);
  });
});
