import { describe, it, expect, beforeEach } from 'vitest';
import { reconcile, SentMessageRegistry } from './reconcile.js';
import type { RendererPayload } from './presentation.js';
import type { ChannelCapabilities, SentMessageRef } from '../channels/adapter.js';

const FULL_CAPS: ChannelCapabilities = {
  supports_edit: true,
  supports_buttons: true,
  supports_threads: true,
  supports_files: true,
  supports_voice: true,
  supports_typing_indicator: true,
  max_message_length: 4096,
  max_attachment_bytes: 20_000_000,
  markdown_dialect: 'telegram-html',
};

const NO_EDIT_CAPS: ChannelCapabilities = { ...FULL_CAPS, supports_edit: false };
const NO_THREAD_CAPS: ChannelCapabilities = { ...FULL_CAPS, supports_edit: false, supports_threads: false };

function makePayload(origin?: string): RendererPayload {
  return {
    session_id: 'sess-1',
    origin_event_id: origin,
    blocks: [{ kind: 'text', text: 'Hello' }],
    status: 'complete',
  };
}

const REF: SentMessageRef = { message_id: '42', channel: 'telegram', thread_id: 'chat-1' };

describe('reconcile', () => {
  let registry: SentMessageRegistry;

  beforeEach(() => {
    registry = new SentMessageRegistry();
  });

  it('chooses edit-in-place when supports_edit=true and origin ref exists', () => {
    registry.register('origin-1', REF);
    const result = reconcile(makePayload('origin-1'), FULL_CAPS, 'chat-1', registry);
    expect(result.strategy).toBe('edit');
    expect(result.edit_ref).toBe(REF);
  });

  it('falls through to thread when supports_edit=true but no ref registered', () => {
    const result = reconcile(makePayload('origin-1'), FULL_CAPS, 'chat-1', registry);
    // No ref → can't edit; but supports_threads=true → thread
    expect(result.strategy).toBe('thread');
    expect(result.target?.thread_id).toBe('chat-1');
  });

  it('falls through to thread when supports_edit=false', () => {
    registry.register('origin-1', REF);
    const result = reconcile(makePayload('origin-1'), NO_EDIT_CAPS, 'chat-1', registry);
    // Even though ref exists, edits are not supported → thread
    expect(result.strategy).toBe('thread');
  });

  it('falls through to new when no edit, no thread', () => {
    const result = reconcile(makePayload('origin-1'), NO_THREAD_CAPS, 'chat-1', registry);
    expect(result.strategy).toBe('new');
    expect(result.target?.thread_id).toBe('chat-1');
  });

  it('uses new strategy when origin_event_id is not set', () => {
    const result = reconcile(makePayload(), FULL_CAPS, 'chat-1', registry);
    expect(result.strategy).toBe('new');
  });

  it('SentMessageRegistry.get returns undefined for unregistered origins', () => {
    expect(registry.get('unregistered')).toBeUndefined();
  });

  it('SentMessageRegistry.clear wipes all refs', () => {
    registry.register('a', REF);
    registry.register('b', REF);
    registry.clear();
    expect(registry.get('a')).toBeUndefined();
    expect(registry.get('b')).toBeUndefined();
  });
});
