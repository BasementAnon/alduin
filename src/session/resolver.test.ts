import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SessionStore } from './store.js';
import { SessionResolver } from './resolver.js';

describe('SessionResolver', () => {
  let store: SessionStore;
  let resolver: SessionResolver;

  beforeEach(() => {
    store = new SessionStore(':memory:');
    resolver = new SessionResolver(store, 'test-tenant');
  });

  afterEach(() => {
    store?.close();
  });

  it('creates a new session on first contact', () => {
    const session = resolver.resolve({
      channel: 'telegram',
      thread_id: '123456789',
      user_id: 'user-1',
      is_group: false,
    });

    expect(session.session_id).toBeTruthy();
    expect(session.channel).toBe('telegram');
    expect(session.external_thread_id).toBe('123456789');
    expect(session.external_user_ids).toContain('user-1');
    expect(session.tenant_id).toBe('test-tenant');
    expect(session.created_at).toBeTruthy();
    expect(session.last_active_at).toBeTruthy();
  });

  it('reuses the existing session on second contact with same thread', () => {
    const first = resolver.resolve({
      channel: 'telegram',
      thread_id: 'chat-999',
      user_id: 'alice',
      is_group: false,
    });

    const second = resolver.resolve({
      channel: 'telegram',
      thread_id: 'chat-999',
      user_id: 'alice',
      is_group: false,
    });

    expect(second.session_id).toBe(first.session_id);
    expect(second.channel).toBe('telegram');
  });

  it('accumulates users across multiple contacts in the same thread', () => {
    resolver.resolve({
      channel: 'telegram',
      thread_id: 'group-42',
      user_id: 'alice',
      is_group: true,
    });

    const second = resolver.resolve({
      channel: 'telegram',
      thread_id: 'group-42',
      user_id: 'bob',
      is_group: true,
    });

    expect(second.external_user_ids).toContain('alice');
    expect(second.external_user_ids).toContain('bob');
  });

  it('sets group_session_id for group chats', () => {
    const session = resolver.resolve({
      channel: 'telegram',
      thread_id: 'supergroup-77',
      user_id: 'user-x',
      is_group: true,
    });

    expect(session.group_session_id).toBeTruthy();
    expect(session.group_session_id).toBe(session.session_id);
  });

  it('does NOT set group_session_id for DMs', () => {
    const session = resolver.resolve({
      channel: 'telegram',
      thread_id: 'dm-12345',
      user_id: 'user-y',
      is_group: false,
    });

    expect(session.group_session_id).toBeUndefined();
  });

  it('creates distinct sessions for different channels with the same thread_id', () => {
    const tgSession = resolver.resolve({
      channel: 'telegram',
      thread_id: 'shared-thread-id',
      user_id: 'alice',
      is_group: false,
    });

    const cliSession = resolver.resolve({
      channel: 'cli',
      thread_id: 'shared-thread-id',
      user_id: 'alice',
      is_group: false,
    });

    expect(tgSession.session_id).not.toBe(cliSession.session_id);
  });

  it('creates distinct sessions for different thread_ids in the same channel', () => {
    const s1 = resolver.resolve({
      channel: 'telegram',
      thread_id: 'chat-001',
      user_id: 'alice',
      is_group: false,
    });
    const s2 = resolver.resolve({
      channel: 'telegram',
      thread_id: 'chat-002',
      user_id: 'alice',
      is_group: false,
    });

    expect(s1.session_id).not.toBe(s2.session_id);
  });

  it('uses the provided tenant_id override', () => {
    const session = resolver.resolve({
      channel: 'telegram',
      thread_id: 'tenant-test',
      user_id: 'admin',
      is_group: false,
      tenant_id: 'acme-corp',
    });

    expect(session.tenant_id).toBe('acme-corp');
  });
});
