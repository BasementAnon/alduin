import type { AlduinEventBus, ExecutorEvent } from '../bus/event-bus.js';
import type { ChannelAdapter, SentMessageRef, ChannelTarget } from '../channels/adapter.js';
import type { RendererPayload, PresentationBlock, FollowupButton } from './presentation.js';
import { buildFailurePayload } from './presentation.js';
import { reconcile, SentMessageRegistry } from './reconcile.js';
import type { ExecutorResult } from '../executor/types.js';

/**
 * Subscribes to the event bus and streams progress back to the channel
 * via edit-in-place, new messages, or file uploads.
 *
 * One RendererSubscriber per session. It:
 * - On 'progress': edits the existing message with a progress block
 * - On 'partial': appends partial content
 * - On 'artifact': sends the file
 * - On 'needs_input': renders followup buttons
 */
export class RendererSubscriber {
  private bus: AlduinEventBus;
  private adapter: ChannelAdapter;
  private threadId: string;
  private sessionId: string;
  private registry: SentMessageRegistry;
  private unsubscribe: (() => void) | null = null;

  /** The ref of the "live" progress message being edited in place */
  private progressRef: SentMessageRef | null = null;

  constructor(
    bus: AlduinEventBus,
    adapter: ChannelAdapter,
    threadId: string,
    sessionId: string
  ) {
    this.bus = bus;
    this.adapter = adapter;
    this.threadId = threadId;
    this.sessionId = sessionId;
    this.registry = new SentMessageRegistry();
  }

  /** Start listening for events on this session */
  start(): void {
    this.unsubscribe = this.bus.subscribe(this.sessionId, (event) => {
      void this.handleEvent(event);
    });
  }

  /** Stop listening */
  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  /**
   * Send a final result payload to the channel.
   * Tries to edit-in-place the progress message if one exists.
   */
  async sendResult(
    result: ExecutorResult,
    originEventId: string,
    traceId?: string
  ): Promise<void> {
    if (
      result.status === 'failed' ||
      result.status === 'timeout' ||
      result.status === 'budget_exceeded'
    ) {
      const payload = buildFailurePayload(this.sessionId, result.status, traceId);
      payload.origin_event_id = originEventId;
      await this.deliver(payload);
      return;
    }

    const blocks: PresentationBlock[] = [];
    const content = result.full_output ?? result.summary;
    blocks.push({ kind: 'markdown', md: content });

    const followups: FollowupButton[] = [];
    if (traceId) {
      followups.push({ label: '📊 Trace', callback_data: `/trace ${traceId}` });
    }

    const payload: RendererPayload = {
      session_id: this.sessionId,
      origin_event_id: originEventId,
      blocks,
      followups: followups.length > 0 ? followups : undefined,
      status: 'complete',
      meta: {
        trace_id: traceId,
        cost_usd: result.usage.cost_usd,
      },
    };

    await this.deliver(payload);
  }

  private async handleEvent(event: ExecutorEvent): Promise<void> {
    const originId = `${event.task_id}-${event.step_index}`;

    switch (event.kind) {
      case 'progress': {
        const label =
          typeof event.data === 'string'
            ? event.data
            : (event.data as { label?: string })?.label ?? 'Working…';
        const pct = (event.data as { pct?: number })?.pct;

        const payload: RendererPayload = {
          session_id: event.session_id,
          origin_event_id: originId,
          blocks: [{ kind: 'progress', label, pct }],
          status: 'in_progress',
        };
        await this.deliver(payload);
        break;
      }

      case 'partial': {
        const text =
          typeof event.data === 'string'
            ? event.data
            : (event.data as { text?: string })?.text ?? '';
        const payload: RendererPayload = {
          session_id: event.session_id,
          origin_event_id: originId,
          blocks: [{ kind: 'markdown', md: text }],
          status: 'partial',
        };
        await this.deliver(payload);
        break;
      }

      case 'artifact': {
        // Stub: artifacts will be full AttachmentRefs once ingestion is wired
        const payload: RendererPayload = {
          session_id: event.session_id,
          blocks: [{ kind: 'text', text: `📎 File ready: ${JSON.stringify(event.data)}` }],
          status: 'complete',
        };
        await this.deliver(payload);
        break;
      }

      case 'needs_input': {
        const prompt =
          typeof event.data === 'string'
            ? event.data
            : (event.data as { prompt?: string })?.prompt ?? 'Input needed';
        const options = (event.data as { options?: string[] })?.options ?? [];

        const followups: FollowupButton[] = options.map((opt) => ({
          label: opt,
          callback_data: `input:${event.task_id}:${opt}`,
        }));

        const payload: RendererPayload = {
          session_id: event.session_id,
          origin_event_id: originId,
          blocks: [{ kind: 'text', text: prompt }],
          followups,
          status: 'needs_input',
        };
        await this.deliver(payload);
        break;
      }

      case 'tool_call':
        // Tool calls are logged in traces but not rendered to the user
        break;
    }
  }

  /**
   * Deliver a RendererPayload through the adapter using the reconcile strategy.
   */
  private async deliver(payload: RendererPayload): Promise<void> {
    const result = reconcile(
      payload,
      this.adapter.capabilities,
      this.threadId,
      this.registry
    );

    const simplePayload = {
      text: payload.blocks.map((b) => {
        switch (b.kind) {
          case 'text': return b.text;
          case 'markdown': return b.md;
          case 'code': return `\`\`\`${b.lang}\n${b.source}\`\`\``;
          case 'card': return `**${b.title}**\n${b.body}`;
          case 'progress': return `⏳ ${b.label}${b.pct !== undefined ? ` (${b.pct}%)` : ''}`;
          case 'quote': return `> ${b.text}`;
        }
      }).join('\n\n'),
      parse_mode: 'html' as const,
      buttons: payload.followups?.map((f) => [
        { label: f.label, callback_data: f.callback_data },
      ]),
    };

    try {
      if (result.strategy === 'edit' && result.edit_ref) {
        await this.adapter.edit(result.edit_ref, simplePayload);
      } else {
        const target = result.target ?? { thread_id: this.threadId };
        const ref = await this.adapter.send(simplePayload, target);

        // Register the ref so future payloads with the same origin can edit
        if (payload.origin_event_id) {
          this.registry.register(payload.origin_event_id, ref);
          this.progressRef = ref;
        }
      }
    } catch (err) {
      console.error(
        `[RendererSubscriber] Failed to deliver to ${this.adapter.id}:`,
        err instanceof Error ? err.message : err
      );
    }
  }
}
