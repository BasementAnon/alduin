import { v4 as uuidv4 } from 'uuid';
import type { Update, Message } from 'grammy/types';
import type { NormalizedEvent, AttachmentRef, SentMessageRef } from '../adapter.js';
import type { IngestionPipeline, ChannelDownloadConfig } from '../../ingestion/pipeline.js';

/** Normalize a Telegram Update into a NormalizedEvent */
export function parseUpdate(update: Update): NormalizedEvent | null {
  const receivedAt = new Date().toISOString();

  // ── Text message ───────────────────────────────────────────────────────────
  if (update.message) {
    return parseMessage(update.message, receivedAt, false);
  }

  // ── Edited message ─────────────────────────────────────────────────────────
  if (update.edited_message) {
    return parseMessage(update.edited_message, receivedAt, true);
  }

  // ── Callback query (button press) ─────────────────────────────────────────
  if (update.callback_query) {
    const cq = update.callback_query;
    const chat = cq.message?.chat;
    if (!chat) return null;

    const threadId = String(chat.id);
    const userId = String(cq.from.id);
    const isGroup = chat.type === 'group' || chat.type === 'supergroup';

    const originRef: SentMessageRef | undefined = cq.message
      ? {
          message_id: String(cq.message.message_id),
          channel: 'telegram',
          thread_id: threadId,
        }
      : undefined;

    return {
      event_id: `tg-cbq-${cq.id}`,
      channel: 'telegram',
      received_at: receivedAt,
      external: {
        thread_id: threadId,
        user_id: userId,
        user_handle: cq.from.username,
        is_group: isGroup,
        message_id: cq.message ? String(cq.message.message_id) : cq.id,
      },
      kind: 'callback',
      callback: originRef
        ? { payload: cq.data ?? '', origin_ref: originRef }
        : undefined,
      raw: update,
    };
  }

  return null;
}

function parseMessage(
  msg: Message,
  receivedAt: string,
  isEdit: boolean
): NormalizedEvent {
  const threadId = String(msg.chat.id);
  const userId = String(msg.from?.id ?? msg.chat.id);
  const isGroup =
    msg.chat.type === 'group' || msg.chat.type === 'supergroup';
  const messageId = String(msg.message_id);

  // Determine event kind and collect attachments
  let kind: NormalizedEvent['kind'] = isEdit ? 'edit' : 'message';
  const attachments: AttachmentRef[] = [];

  if (msg.photo) {
    kind = 'file';
    // Telegram sends multiple sizes; take the largest
    const largest = [...msg.photo].sort((a, b) => (b.file_size ?? 0) - (a.file_size ?? 0))[0];
    if (largest) {
      attachments.push(makeAttachmentStub(largest.file_id, 'image', 'image/jpeg', largest.file_size ?? 0));
    }
  } else if (msg.document) {
    kind = 'file';
    attachments.push(
      makeAttachmentStub(
        msg.document.file_id,
        'document',
        msg.document.mime_type ?? 'application/octet-stream',
        msg.document.file_size ?? 0
      )
    );
  } else if (msg.voice) {
    kind = 'voice';
    attachments.push(
      makeAttachmentStub(msg.voice.file_id, 'voice', msg.voice.mime_type ?? 'audio/ogg', msg.voice.file_size ?? 0)
    );
  } else if (msg.audio) {
    kind = 'file';
    attachments.push(
      makeAttachmentStub(msg.audio.file_id, 'audio', msg.audio.mime_type ?? 'audio/mpeg', msg.audio.file_size ?? 0)
    );
  } else if (msg.video) {
    kind = 'file';
    attachments.push(
      makeAttachmentStub(msg.video.file_id, 'video', msg.video.mime_type ?? 'video/mp4', msg.video.file_size ?? 0)
    );
  }

  const event: NormalizedEvent = {
    event_id: `tg-msg-${msg.message_id}-${msg.chat.id}`,
    channel: 'telegram',
    received_at: receivedAt,
    external: {
      thread_id: threadId,
      user_id: userId,
      user_handle: msg.from?.username,
      is_group: isGroup,
      message_id: messageId,
      ...(isEdit ? { edit_of: messageId } : {}),
    },
    kind,
    text: msg.text ?? msg.caption,
    ...(attachments.length > 0 ? { attachments } : {}),
    raw: msg,
  };

  return event;
}

/**
 * Build a stub AttachmentRef for a Telegram file.
 * The stub's storage_uri encodes the Telegram file_id so the ingestion
 * pipeline can download it. Ingestion replaces this with the real path.
 */
function makeAttachmentStub(
  fileId: string,
  kind: AttachmentRef['kind'],
  mime: string,
  bytes: number
): AttachmentRef {
  return {
    attachment_id: uuidv4(),
    kind,
    mime,
    bytes,
    storage_uri: `telegram-file://${fileId}`,
    ttl_expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(), // 1h stub TTL
  };
}

const DEFAULT_ATTACHMENT_TIMEOUT_MS = 30_000;

/**
 * Parse a Telegram Update and run any attachments through the ingestion pipeline.
 * The event is not returned until ingestion completes or the per-attachment
 * timeout fires (default 30s), whichever comes first.
 *
 * @param update        - Raw Telegram Update
 * @param pipeline      - Configured IngestionPipeline instance
 * @param channelConfig - Bot token for Telegram file downloads
 * @param timeoutMs     - Per-attachment timeout (default 30s)
 */
export async function parseAndIngestUpdate(
  update: Update,
  pipeline: IngestionPipeline,
  channelConfig: ChannelDownloadConfig,
  timeoutMs = DEFAULT_ATTACHMENT_TIMEOUT_MS
): Promise<NormalizedEvent | null> {
  const event = parseUpdate(update);
  if (!event || !event.attachments || event.attachments.length === 0) {
    return event;
  }

  // Run all attachment stubs through the pipeline concurrently,
  // racing each against a per-attachment timeout.
  const ingestedAttachments = await Promise.all(
    event.attachments.map(async (stub) => {
      const timeoutPromise: Promise<null> = new Promise((resolve) =>
        setTimeout(() => resolve(null), timeoutMs)
      );
      const ingestPromise = pipeline.ingest(stub, channelConfig).then((result) =>
        result.ok ? result.ref! : stub
      );
      const result = await Promise.race([ingestPromise, timeoutPromise]);
      // On timeout, fall back to the original stub so the event still proceeds
      return result ?? stub;
    })
  );

  return { ...event, attachments: ingestedAttachments };
}
