import type { ChannelCapabilities } from '../adapter.js';
import type {
  PresentationBlock,
  RendererPayload,
  FollowupButton,
} from '../../renderer/presentation.js';

/** A queued Telegram API action produced by the renderer */
export interface TelegramAction {
  method: 'sendMessage' | 'editMessageText' | 'sendDocument' | 'sendPhoto' | 'sendChatAction';
  params: Record<string, unknown>;
}

// ── Telegram HTML escaping ────────────────────────────────────────────────────

const ESCAPE_MAP: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
};

/** Escape characters that conflict with Telegram HTML */
export function escapeTelegramHtml(text: string): string {
  return text.replace(/[&<>]/g, (ch) => ESCAPE_MAP[ch] ?? ch);
}

// ── Markdown → Telegram HTML conversion ───────────────────────────────────────

/**
 * Convert a subset of markdown to Telegram-supported HTML tags.
 * Handles: bold, italic, code spans, code fences, and links.
 *
 * Every captured group is passed through `escapeTelegramHtml` before being
 * interpolated into the output tag, so a crafted input like
 *   `_</i><b>injected_`
 * is rendered as `<i>&lt;/i&gt;&lt;b&gt;injected</i>` rather than allowing
 * the attacker to break out of the italic span and inject fresh HTML. H-6.
 */
export function markdownToTelegramHtml(md: string): string {
  let html = md;

  // Code fences (must come before inline transforms)
  html = html.replace(
    /```(\w*)\n([\s\S]*?)```/g,
    (_match, lang: string, code: string) => {
      const escaped = escapeTelegramHtml(code.trimEnd());
      return lang
        ? `<pre><code class="language-${escapeTelegramHtml(lang)}">${escaped}</code></pre>`
        : `<pre>${escaped}</pre>`;
    }
  );

  // Inline code
  html = html.replace(/`([^`]+)`/g, (_match, code: string) => {
    return `<code>${escapeTelegramHtml(code)}</code>`;
  });

  // Bold (**text** or __text__) — escape captured content so a crafted
  // markdown input can't smuggle HTML tags through the replacement string.
  html = html.replace(/\*\*(.+?)\*\*/g, (_match, inner: string) => {
    return `<b>${escapeTelegramHtml(inner)}</b>`;
  });
  html = html.replace(/__(.+?)__/g, (_match, inner: string) => {
    return `<b>${escapeTelegramHtml(inner)}</b>`;
  });

  // Italic (*text* or _text_ — but not inside already-transformed bold/code)
  html = html.replace(/(?<!\w)\*([^*]+?)\*(?!\w)/g, (_match, inner: string) => {
    return `<i>${escapeTelegramHtml(inner)}</i>`;
  });
  html = html.replace(/(?<!\w)_([^_]+?)_(?!\w)/g, (_match, inner: string) => {
    return `<i>${escapeTelegramHtml(inner)}</i>`;
  });

  // Links [text](url) — escape both label and href so that neither can
  // inject additional HTML attributes or break out of the anchor tag.
  html = html.replace(
    /\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g,
    (_match, label: string, url: string) => {
      return `<a href="${escapeTelegramHtml(url)}">${escapeTelegramHtml(label)}</a>`;
    }
  );

  return html;
}

// ── Block rendering ───────────────────────────────────────────────────────────

/** Render a single PresentationBlock to Telegram HTML */
export function renderBlock(block: PresentationBlock): string {
  switch (block.kind) {
    case 'text':
      return escapeTelegramHtml(block.text);

    case 'markdown':
      return markdownToTelegramHtml(block.md);

    case 'code':
      return block.lang
        ? `<pre><code class="language-${escapeTelegramHtml(block.lang)}">${escapeTelegramHtml(block.source)}</code></pre>`
        : `<pre>${escapeTelegramHtml(block.source)}</pre>`;

    case 'card': {
      let html = `<b>${escapeTelegramHtml(block.title)}</b>\n${escapeTelegramHtml(block.body)}`;
      if (block.fields) {
        for (const f of block.fields) {
          html += `\n<b>${escapeTelegramHtml(f.key)}:</b> ${escapeTelegramHtml(f.value)}`;
        }
      }
      return html;
    }

    case 'progress': {
      const pctStr = block.pct !== undefined ? ` (${block.pct}%)` : '';
      return `⏳ ${escapeTelegramHtml(block.label)}${pctStr}`;
    }

    case 'quote':
      return block.cite
        ? `<blockquote>${escapeTelegramHtml(block.text)}\n— ${escapeTelegramHtml(block.cite)}</blockquote>`
        : `<blockquote>${escapeTelegramHtml(block.text)}</blockquote>`;
  }
}

// ── Trace tree collapsing ────────────────────────────────────────────────────

/**
 * Collapse a recursive trace tree to fit within a character limit.
 * Elides deeper child nodes (depth >= collapseDepth) with "…".
 * The summary line (Σ) is always preserved.
 *
 * @param traceTree  Output of TraceLogger.formatTraceTree()
 * @param maxChars   Maximum character count (default 4096 for Telegram)
 * @returns Collapsed tree text that fits within maxChars
 */
export function collapseTraceTree(traceTree: string, maxChars = 4096): string {
  if (traceTree.length <= maxChars) return traceTree;

  const lines = traceTree.split('\n');
  // The last line is always the Σ summary — preserve it
  const summaryLine = lines[lines.length - 1] ?? '';
  const treeLines = lines.slice(0, -1);

  // Progressively collapse deeper indentation levels until it fits
  for (let collapseDepth = 3; collapseDepth >= 1; collapseDepth--) {
    const indentThreshold = '  '.repeat(collapseDepth);
    const collapsed: string[] = [];
    let elided = false;

    for (const line of treeLines) {
      if (line.startsWith(indentThreshold) && !line.startsWith(indentThreshold + '▸')) {
        // This line is at or deeper than the collapse threshold
        if (!elided) {
          collapsed.push(`${indentThreshold}…`);
          elided = true;
        }
        // Skip the line
      } else {
        collapsed.push(line);
        elided = false;
      }
    }

    collapsed.push(summaryLine);
    const result = collapsed.join('\n');
    if (result.length <= maxChars) return result;
  }

  // If even collapsing to depth 1 doesn't fit, truncate and add ellipsis
  const truncated = traceTree.slice(0, maxChars - summaryLine.length - 10) + '\n…\n' + summaryLine;
  return truncated;
}

// ── Chunking ──────────────────────────────────────────────────────────────────

/**
 * Split text into chunks that fit within Telegram's 4096-char limit.
 * Avoids breaking inside HTML tags or <pre>...</pre> blocks when possible.
 */
export function chunkText(text: string, maxLen = 4096): string[] {
  if (text.length <= maxLen) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxLen) {
      chunks.push(remaining);
      break;
    }

    // Try to break at a double newline (paragraph boundary)
    let splitAt = remaining.lastIndexOf('\n\n', maxLen);
    if (splitAt < maxLen * 0.3) {
      // If no good paragraph break, try a single newline
      splitAt = remaining.lastIndexOf('\n', maxLen);
    }
    if (splitAt < maxLen * 0.3) {
      // Last resort: hard break at limit
      splitAt = maxLen;
    }

    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).replace(/^\n+/, '');
  }

  return chunks;
}

// ── Keyboard building ─────────────────────────────────────────────────────────

/** Build a Telegram InlineKeyboardMarkup from followup buttons */
export function buildInlineKeyboard(
  buttons: FollowupButton[]
): { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> } {
  // One button per row for readability
  return {
    inline_keyboard: buttons.map((b) => [
      { text: b.label, callback_data: b.callback_data },
    ]),
  };
}

// ── Full payload renderer ─────────────────────────────────────────────────────

/**
 * Render a RendererPayload into an ordered list of Telegram API actions.
 * The caller executes them sequentially.
 */
export function renderPayload(
  payload: RendererPayload,
  capabilities: ChannelCapabilities,
  chatId: string
): TelegramAction[] {
  const actions: TelegramAction[] = [];

  // Typing indicator for in-progress events
  if (payload.status === 'in_progress' && capabilities.supports_typing_indicator) {
    actions.push({
      method: 'sendChatAction',
      params: { chat_id: chatId, action: 'typing' },
    });
  }

  // Render all blocks into a single HTML string
  const htmlParts = payload.blocks.map(renderBlock);
  const fullHtml = htmlParts.join('\n\n');

  // Add cost footer for completed payloads
  const footer =
    payload.status === 'complete' && payload.meta?.cost_usd !== undefined
      ? `\n\n<i>Cost: $${payload.meta.cost_usd.toFixed(4)}</i>`
      : '';

  const bodyHtml = fullHtml + footer;

  // Chunk the body for Telegram's 4096-char limit
  const chunks = chunkText(bodyHtml, capabilities.max_message_length);

  // Build keyboard from followup buttons (only on last chunk)
  const keyboard =
    payload.followups && payload.followups.length > 0 && capabilities.supports_buttons
      ? buildInlineKeyboard(payload.followups)
      : undefined;

  for (let i = 0; i < chunks.length; i++) {
    const isLast = i === chunks.length - 1;
    actions.push({
      method: 'sendMessage',
      params: {
        chat_id: chatId,
        text: chunks[i],
        parse_mode: 'HTML',
        ...(isLast && keyboard ? { reply_markup: keyboard } : {}),
      },
    });
  }

  // File attachments
  if (payload.files && capabilities.supports_files) {
    for (const file of payload.files) {
      const isImage = file.kind === 'image' || file.mime.startsWith('image/');
      actions.push({
        method: isImage ? 'sendPhoto' : 'sendDocument',
        params: {
          chat_id: chatId,
          [isImage ? 'photo' : 'document']: file.storage_uri,
          caption: file.enrichment?.extracted_title,
        },
      });
    }
  }

  return actions;
}
