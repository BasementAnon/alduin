import { describe, it, expect } from 'vitest';
import {
  escapeTelegramHtml,
  markdownToTelegramHtml,
  renderBlock,
  chunkText,
  buildInlineKeyboard,
  renderPayload,
  collapseTraceTree,
} from './renderer.js';
import { TELEGRAM_CAPABILITIES } from './capabilities.js';
import type { RendererPayload } from '../../renderer/presentation.js';

// ── escapeTelegramHtml ────────────────────────────────────────────────────────
describe('escapeTelegramHtml', () => {
  it('escapes &, <, >', () => {
    expect(escapeTelegramHtml('a < b & c > d')).toBe('a &lt; b &amp; c &gt; d');
  });

  it('leaves normal text unchanged', () => {
    expect(escapeTelegramHtml('Hello world')).toBe('Hello world');
  });
});

// ── markdownToTelegramHtml ────────────────────────────────────────────────────
describe('markdownToTelegramHtml', () => {
  it('converts **bold** to <b>', () => {
    expect(markdownToTelegramHtml('**hello**')).toBe('<b>hello</b>');
  });

  it('converts *italic* to <i>', () => {
    expect(markdownToTelegramHtml('*hello*')).toBe('<i>hello</i>');
  });

  it('converts inline `code` to <code>', () => {
    expect(markdownToTelegramHtml('use `npm install`')).toBe(
      'use <code>npm install</code>'
    );
  });

  it('escapes HTML entities inside inline code', () => {
    expect(markdownToTelegramHtml('`a < b>`')).toContain('&lt;');
  });

  it('converts code fences to <pre>', () => {
    const md = '```js\nconst x = 1;\n```';
    const html = markdownToTelegramHtml(md);
    expect(html).toContain('<pre>');
    expect(html).toContain('language-js');
    expect(html).toContain('const x = 1;');
  });

  it('converts [link](url) to <a href>', () => {
    expect(markdownToTelegramHtml('[Google](https://google.com)')).toBe(
      '<a href="https://google.com">Google</a>'
    );
  });
});

// ── renderBlock ───────────────────────────────────────────────────────────────
describe('renderBlock', () => {
  it('renders a text block with HTML escaping', () => {
    expect(renderBlock({ kind: 'text', text: 'a < b' })).toBe('a &lt; b');
  });

  it('renders a code block with language', () => {
    const html = renderBlock({ kind: 'code', lang: 'python', source: 'print(1)' });
    expect(html).toContain('language-python');
    expect(html).toContain('print(1)');
  });

  it('renders a card block with title and fields', () => {
    const html = renderBlock({
      kind: 'card',
      title: 'Status',
      body: 'All good',
      fields: [{ key: 'Uptime', value: '99.9%' }],
    });
    expect(html).toContain('<b>Status</b>');
    expect(html).toContain('<b>Uptime:</b> 99.9%');
  });

  it('renders a progress block', () => {
    const html = renderBlock({ kind: 'progress', label: 'Loading', pct: 42 });
    expect(html).toContain('Loading');
    expect(html).toContain('42%');
  });

  it('renders a quote block with cite', () => {
    const html = renderBlock({ kind: 'quote', text: 'To be or not', cite: 'Shakespeare' });
    expect(html).toContain('<blockquote>');
    expect(html).toContain('Shakespeare');
  });
});

// ── chunkText ─────────────────────────────────────────────────────────────────
describe('chunkText', () => {
  it('returns a single chunk for short text', () => {
    expect(chunkText('hello', 4096)).toEqual(['hello']);
  });

  it('splits at paragraph boundaries when possible', () => {
    const text = 'Paragraph one.\n\nParagraph two.\n\nParagraph three.';
    const chunks = chunkText(text, 30);
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    expect(chunks[0]).toContain('Paragraph one');
  });

  it('never produces chunks larger than maxLen', () => {
    const longLine = 'x'.repeat(5000);
    const chunks = chunkText(longLine, 4096);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(4096);
    }
  });
});

// ── buildInlineKeyboard ───────────────────────────────────────────────────────
describe('buildInlineKeyboard', () => {
  it('builds one row per button', () => {
    const kb = buildInlineKeyboard([
      { label: 'Yes', callback_data: 'yes' },
      { label: 'No', callback_data: 'no' },
    ]);
    expect(kb.inline_keyboard).toHaveLength(2);
    expect(kb.inline_keyboard[0]![0]!.text).toBe('Yes');
    expect(kb.inline_keyboard[1]![0]!.callback_data).toBe('no');
  });
});

// ── renderPayload ─────────────────────────────────────────────────────────────
describe('renderPayload', () => {
  it('emits a typing indicator for in_progress status', () => {
    const payload: RendererPayload = {
      session_id: 's1',
      blocks: [{ kind: 'progress', label: 'Thinking…' }],
      status: 'in_progress',
    };
    const actions = renderPayload(payload, TELEGRAM_CAPABILITIES, '12345');
    const typing = actions.find((a) => a.method === 'sendChatAction');
    expect(typing).toBeDefined();
    expect(typing!.params['action']).toBe('typing');
  });

  it('does NOT emit a typing indicator for complete status', () => {
    const payload: RendererPayload = {
      session_id: 's1',
      blocks: [{ kind: 'text', text: 'Done' }],
      status: 'complete',
    };
    const actions = renderPayload(payload, TELEGRAM_CAPABILITIES, '12345');
    expect(actions.find((a) => a.method === 'sendChatAction')).toBeUndefined();
  });

  it('includes an inline keyboard when followups are present', () => {
    const payload: RendererPayload = {
      session_id: 's1',
      blocks: [{ kind: 'text', text: 'Choose' }],
      followups: [{ label: 'A', callback_data: 'a' }],
      status: 'needs_input',
    };
    const actions = renderPayload(payload, TELEGRAM_CAPABILITIES, '12345');
    const sendMsg = actions.find((a) => a.method === 'sendMessage');
    expect(sendMsg?.params['reply_markup']).toBeDefined();
  });

  it('renders file attachments as sendPhoto/sendDocument', () => {
    const payload: RendererPayload = {
      session_id: 's1',
      blocks: [{ kind: 'text', text: 'Here is the file' }],
      files: [
        {
          attachment_id: 'f1',
          kind: 'image',
          mime: 'image/png',
          bytes: 1024,
          storage_uri: '/tmp/img.png',
          ttl_expires_at: new Date().toISOString(),
        },
        {
          attachment_id: 'f2',
          kind: 'document',
          mime: 'application/pdf',
          bytes: 2048,
          storage_uri: '/tmp/doc.pdf',
          ttl_expires_at: new Date().toISOString(),
        },
      ],
      status: 'complete',
    };
    const actions = renderPayload(payload, TELEGRAM_CAPABILITIES, '12345');
    expect(actions.filter((a) => a.method === 'sendPhoto')).toHaveLength(1);
    expect(actions.filter((a) => a.method === 'sendDocument')).toHaveLength(1);
  });

  it('adds a cost footer for completed payloads', () => {
    const payload: RendererPayload = {
      session_id: 's1',
      blocks: [{ kind: 'text', text: 'Result' }],
      status: 'complete',
      meta: { cost_usd: 0.0123 },
    };
    const actions = renderPayload(payload, TELEGRAM_CAPABILITIES, '12345');
    const sendMsg = actions.find((a) => a.method === 'sendMessage');
    expect(sendMsg?.params['text']).toContain('$0.0123');
  });
});

// ── collapseTraceTree ────────────────────────────────────────────────────────

describe('collapseTraceTree', () => {
  it('returns short trees unchanged', () => {
    const tree = '▸ plan (sonnet, $0.004, 1.1s)\nΣ $0.004 · 1.1s · 1 calls · depth max 0';
    expect(collapseTraceTree(tree)).toBe(tree);
  });

  it('collapses deep nodes with … when exceeding limit', () => {
    // Build a tree that exceeds a small limit
    const lines = [
      '▸ plan (sonnet, $0.004, 1.1s)',
      '├─ step 0 via qwen ($0, 2.0s)',
      '  ├─ sub-orchestrate → qwen (depth=1)',
      '    ├─ child step via qwen ($0, 1.0s)',
      '    ├─ child step 2 via qwen ($0, 0.5s)',
      '    └─ child result (qwen, $0, 1.5s)',
      '  └─ child result (qwen, $0, 2.0s)',
      '├─ step 1 via sonnet ($0.006, 1.0s)',
      'Σ $0.010 · 4.1s · 4 calls · depth max 1',
    ];
    const tree = lines.join('\n');

    // Collapse with a tight limit that forces elision
    const collapsed = collapseTraceTree(tree, 200);

    expect(collapsed).toContain('▸ plan');
    expect(collapsed).toContain('Σ');
    expect(collapsed).toContain('…');
    expect(collapsed.length).toBeLessThanOrEqual(200);
  });

  it('preserves the summary line (Σ) always', () => {
    const lines = [
      '▸ plan (sonnet, $0.004, 1.1s)',
      '  ├─ lots of nested content',
      '    ├─ deeply nested',
      '      ├─ very deeply nested',
      'Σ $0.010 · 4.1s · 4 calls · depth max 3',
    ];
    const tree = lines.join('\n');
    const collapsed = collapseTraceTree(tree, 100);

    expect(collapsed).toContain('Σ $0.010');
  });

  it('handles trees with no indentation', () => {
    const tree = '▸ plan (sonnet, $0.004, 1.1s)\n▸ synthesize (sonnet, $0.006, 1.0s)\nΣ $0.010 · 2.1s · 2 calls · depth max 0';
    expect(collapseTraceTree(tree, 50)).toContain('Σ');
  });
});
