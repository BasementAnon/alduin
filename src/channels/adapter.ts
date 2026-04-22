/**
 * Channel adapter contract — the only boundary between the outside world and Alduin.
 * Every channel (Telegram, Slack, Discord, CLI) implements this interface.
 */

// ── Presentation types (stubs — filled in by the renderer prompt) ────────────

/** Channel-neutral presentation payload emitted by the runtime plane */
export interface PresentationPayload {
  text: string;
  parse_mode?: 'html' | 'markdown' | 'plain';
  buttons?: Array<Array<{ label: string; callback_data: string }>>;
  reply_to_message_id?: string;
}

/** Identifies the destination within a channel */
export interface ChannelTarget {
  thread_id: string;
  user_id?: string;
}

// ── Attachment ref ────────────────────────────────────────────────────────────

/** A processed attachment reference — raw bytes are never passed to executors */
export interface AttachmentRef {
  attachment_id: string;
  kind: 'image' | 'document' | 'audio' | 'voice' | 'video' | 'url';
  mime: string;
  bytes: number;
  /** Local blob path or s3:// URI */
  storage_uri: string;
  enrichment?: {
    ocr_text?: string;
    transcript?: string;
    extracted_title?: string;
    extracted_text?: string;
    page_count?: number;
  };
  ttl_expires_at: string;
}

// ── Channel capabilities ──────────────────────────────────────────────────────

/** Declarative capability flags for a channel adapter */
export interface ChannelCapabilities {
  supports_edit: boolean;
  supports_buttons: boolean;
  supports_threads: boolean;
  supports_files: boolean;
  supports_voice: boolean;
  supports_typing_indicator: boolean;
  max_message_length: number;
  /** Max attachment size in bytes */
  max_attachment_bytes: number;
  markdown_dialect:
    | 'telegram-html'
    | 'slack-mrkdwn'
    | 'discord-md'
    | 'commonmark'
    | 'plain';
}

// ── Message reference (for edits) ─────────────────────────────────────────────

/** Opaque reference to a message already sent — used for edits and callback origins */
export interface SentMessageRef {
  message_id: string;
  channel: string;
  thread_id: string;
}

// ── Inbound event types ───────────────────────────────────────────────────────

/** Raw event straight off the wire before normalization */
export interface RawChannelEvent {
  channel: string;
  received_at: string;
  payload: unknown;
}

/** Normalized inbound event — the shape handed to the runtime plane */
export interface NormalizedEvent {
  /** Idempotency key — deduplication uses this */
  event_id: string;
  channel: string;
  received_at: string;
  external: {
    /** e.g. Telegram chat_id */
    thread_id: string;
    user_id: string;
    user_handle?: string;
    is_group: boolean;
    message_id: string;
    /** Set when this event edits a prior message */
    edit_of?: string;
  };
  kind: 'message' | 'callback' | 'edit' | 'file' | 'inline_query' | 'voice';
  text?: string;
  attachments?: AttachmentRef[];
  callback?: { payload: string; origin_ref: SentMessageRef };
  /** Original payload, kept for trace */
  raw: unknown;
}

// ── ChannelAdapter interface ──────────────────────────────────────────────────

/**
 * ChannelAdapter — the single contract all channel integrations implement.
 * Inbound: raw wire events → NormalizedEvent (via onEvent handler)
 * Outbound: PresentationPayload → channel-native messages (via send/edit)
 */
export interface ChannelAdapter {
  /** Unique adapter identifier: "telegram", "slack", "cli" */
  readonly id: string;
  /** Declarative capability matrix */
  readonly capabilities: ChannelCapabilities;

  /** Begin receiving events (start long-poll or register webhook handler) */
  start(): Promise<void>;

  /** Stop receiving events and clean up */
  stop(): Promise<void>;

  /** Send a presentation payload to a channel target */
  send(
    payload: PresentationPayload,
    target: ChannelTarget
  ): Promise<SentMessageRef>;

  /** Edit a previously sent message */
  edit(ref: SentMessageRef, payload: PresentationPayload): Promise<void>;

  /**
   * Register a handler to receive raw channel events.
   * The adapter calls this for every inbound event.
   */
  onEvent(handler: (event: RawChannelEvent) => void): void;

  /**
   * Verify an inbound webhook request's cryptographic signature.
   *
   * Adapters that receive webhooks MUST implement this. The gateway calls it
   * before any other processing. Adapters that don't implement it (e.g. CLI,
   * long-poll-only) leave this undefined — the gateway will fail-closed with
   * 401 in production mode for such adapters.
   *
   * Implementations MUST use crypto.timingSafeEqual (not ===) for secret
   * comparison to prevent timing side-channels.
   *
   * @param headers - The raw request headers (lowercase keys)
   * @param body - The raw request body buffer (for HMAC-based schemes)
   */
  verifyWebhookSignature?(headers: Record<string, string | string[] | undefined>, body?: Buffer): boolean;

  /**
   * Receive a raw webhook event dispatched by the gateway.
   * Adapters that handle webhook-originating events via the gateway's generic
   * dispatch path (i.e. not Telegram's grammy middleware) implement this.
   * Adapters that don't implement it simply don't receive generic-path events.
   */
  dispatchRawEvent?(event: RawChannelEvent): void;
}
