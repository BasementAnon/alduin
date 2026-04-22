import type { ChannelCapabilities, SentMessageRef, ChannelTarget } from '../channels/adapter.js';
import type { RendererPayload } from './presentation.js';

export type ReconcileStrategy = 'edit' | 'thread' | 'new';

export interface ReconcileResult {
  strategy: ReconcileStrategy;
  /** Present for 'edit' strategy — the message to edit in place */
  edit_ref?: SentMessageRef;
  /** Present for 'thread' or 'new' strategy — where to send */
  target?: ChannelTarget;
}

/**
 * Active sent-message references, keyed by origin_event_id.
 * The renderer subscriber registers refs as messages are sent,
 * so later payloads targeting the same origin can edit in place.
 */
export class SentMessageRegistry {
  private refs = new Map<string, SentMessageRef>();

  register(originEventId: string, ref: SentMessageRef): void {
    this.refs.set(originEventId, ref);
  }

  get(originEventId: string): SentMessageRef | undefined {
    return this.refs.get(originEventId);
  }

  clear(): void {
    this.refs.clear();
  }
}

/**
 * Reconcile a RendererPayload into a delivery strategy.
 *
 * Strategy ladder (priority order):
 * 1. **Edit in place** — if channel supports edits, origin_event_id is set,
 *    and we have a SentMessageRef for that origin.
 * 2. **Threaded reply** — if the channel supports threads.
 * 3. **New message** — fallback, always works.
 */
export function reconcile(
  payload: RendererPayload,
  capabilities: ChannelCapabilities,
  threadId: string,
  registry: SentMessageRegistry
): ReconcileResult {
  // 1. Edit in place
  if (
    capabilities.supports_edit &&
    payload.origin_event_id
  ) {
    const ref = registry.get(payload.origin_event_id);
    if (ref) {
      return { strategy: 'edit', edit_ref: ref };
    }
  }

  // 2. Threaded reply
  if (capabilities.supports_threads && payload.origin_event_id) {
    return {
      strategy: 'thread',
      target: { thread_id: threadId },
    };
  }

  // 3. New message (fallback — always works)
  return {
    strategy: 'new',
    target: { thread_id: threadId },
  };
}
