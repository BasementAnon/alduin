import { randomUUID } from 'node:crypto';
import type { Session } from './types.js';
import { SessionStore } from './store.js';

export interface ResolveOptions {
  channel: string;
  thread_id: string;
  user_id: string;
  is_group: boolean;
  tenant_id?: string;
}

/**
 * Session resolver.
 * Maps (channel, thread_id) → Session, creating one on first contact.
 *
 * Group sessions get a group_session_id. Each user in a group also gets their
 * own sub_session_id for private context (e.g. "my calendar" in a group chat
 * resolves to that user's personal session, not the group session).
 */
export class SessionResolver {
  private store: SessionStore;
  private defaultTenantId: string;

  constructor(store: SessionStore, defaultTenantId = 'default') {
    this.store = store;
    this.defaultTenantId = defaultTenantId;
  }

  /**
   * Resolve a (channel, thread_id, user_id) tuple to a Session.
   * Creates the session if it doesn't exist. Updates last_active_at.
   */
  resolve(options: ResolveOptions): Session {
    const { channel, thread_id, user_id, is_group } = options;
    const tenantId = options.tenant_id ?? this.defaultTenantId;

    const existing = this.store.findByThread(channel, thread_id);
    if (existing) {
      this.store.touch(existing.session_id, user_id);
      // Re-fetch to get updated user_ids
      return this.store.findById(existing.session_id) ?? existing;
    }

    const now = new Date().toISOString();
    const sessionId = randomUUID();

    const session: Session = {
      session_id: sessionId,
      channel,
      external_thread_id: thread_id,
      external_user_ids: [user_id],
      group_session_id: is_group ? sessionId : undefined,
      tenant_id: tenantId,
      created_at: now,
      last_active_at: now,
    };

    this.store.create(session);
    return session;
  }
}
