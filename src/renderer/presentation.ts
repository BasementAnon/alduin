import { z } from 'zod';
import type { AttachmentRef } from '../channels/adapter.js';

// ── Block types ───────────────────────────────────────────────────────────────

export type PresentationBlock =
  | { kind: 'text'; text: string }
  | { kind: 'markdown'; md: string }
  | { kind: 'code'; lang: string; source: string }
  | { kind: 'card'; title: string; body: string; fields?: Array<{ key: string; value: string }> }
  | { kind: 'progress'; label: string; pct?: number }
  | { kind: 'quote'; text: string; cite?: string };

export interface FollowupButton {
  label: string;
  /** Callback data sent back when pressed */
  callback_data: string;
}

/** Channel-neutral presentation payload emitted by the runtime plane */
export interface RendererPayload {
  session_id: string;
  /** If set, the renderer should edit-in-place the message this references */
  origin_event_id?: string;
  blocks: PresentationBlock[];
  followups?: FollowupButton[];
  files?: AttachmentRef[];
  status?: 'in_progress' | 'complete' | 'failed' | 'partial' | 'needs_input';
  meta?: { trace_id?: string; cost_usd?: number };
}

// ── Zod schemas for runtime validation ────────────────────────────────────────

const kvSchema = z.object({ key: z.string(), value: z.string() });

export const presentationBlockSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('text'), text: z.string() }),
  z.object({ kind: z.literal('markdown'), md: z.string() }),
  z.object({ kind: z.literal('code'), lang: z.string(), source: z.string() }),
  z.object({
    kind: z.literal('card'),
    title: z.string(),
    body: z.string(),
    fields: z.array(kvSchema).optional(),
  }),
  z.object({
    kind: z.literal('progress'),
    label: z.string(),
    pct: z.number().min(0).max(100).optional(),
  }),
  z.object({
    kind: z.literal('quote'),
    text: z.string(),
    cite: z.string().optional(),
  }),
]);

export const followupButtonSchema = z.object({
  label: z.string(),
  callback_data: z.string(),
});

export const rendererPayloadSchema = z.object({
  session_id: z.string(),
  origin_event_id: z.string().optional(),
  blocks: z.array(presentationBlockSchema),
  followups: z.array(followupButtonSchema).optional(),
  status: z
    .enum(['in_progress', 'complete', 'failed', 'partial', 'needs_input'])
    .optional(),
  meta: z
    .object({
      trace_id: z.string().optional(),
      cost_usd: z.number().optional(),
    })
    .optional(),
});

// ── Failure payload builders ──────────────────────────────────────────────────

/**
 * Build a user-friendly failure payload.
 * Never exposes stack traces — those go to the trace logger only.
 */
export function buildFailurePayload(
  sessionId: string,
  status: 'failed' | 'timeout' | 'budget_exceeded' | 'policy_denied',
  traceId?: string
): RendererPayload {
  const messages: Record<string, string> = {
    failed:
      "Something went wrong while processing your request. The team has been notified. You can try again or type /trace to see what happened.",
    timeout:
      "Your request took too long and was stopped. This can happen with complex tasks. Try breaking it into smaller steps.",
    budget_exceeded:
      "You've reached the daily usage limit. The budget resets at midnight UTC. Type /budget to see the current status.",
    policy_denied:
      "This action isn't allowed under the current permissions. Contact an admin or type /help for what you can do.",
  };

  const followups: FollowupButton[] = [
    { label: 'Retry', callback_data: '/retry' },
    { label: 'Trace', callback_data: `/trace ${traceId ?? 'latest'}` },
  ];

  return {
    session_id: sessionId,
    blocks: [{ kind: 'text', text: messages[status] ?? messages['failed']! }],
    followups,
    status: 'failed',
    meta: traceId ? { trace_id: traceId } : undefined,
  };
}
