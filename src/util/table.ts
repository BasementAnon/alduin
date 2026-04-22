// ─────────────────────────────────────────────────────────────
// Adapted from OpenClaw (MIT, © Peter Steinberger)
//   Origin: src/terminal/table.ts
//   Origin SHA: 778ac4330aa32b9ce4482f0d1a3d4f744ff7f17f
//   Ported: 2026-04-15
// ─────────────────────────────────────────────────────────────

/**
 * Lightweight ANSI-safe terminal table renderer.
 *
 * Adapted from OpenClaw's src/terminal/table.ts. The full OpenClaw version
 * supports grapheme-aware ANSI wrapping via splitGraphemes/visibleWidth. This
 * port replaces those with a simpler ANSI-strip approach that is sufficient for
 * doctor/config output (no ANSI codes inside cells).
 *
 * TODO: upgrade to full grapheme-aware ANSI wrapping when cell content gains
 * color codes.
 */

export type Align = 'left' | 'right' | 'center';
export type BorderStyle = 'unicode' | 'ascii' | 'none';

export interface TableColumn {
  key: string;
  header: string;
  align?: Align;
  minWidth?: number;
  maxWidth?: number;
  /** If true, column absorbs remaining space after fixed columns are sized. */
  flex?: boolean;
}

export interface RenderTableOptions {
  columns: TableColumn[];
  rows: Array<Record<string, string>>;
  /** Terminal width — defaults to stdout.columns or 120. */
  width?: number;
  /** Horizontal padding inside each cell (default 1). */
  padding?: number;
  border?: BorderStyle;
}

// ── ANSI escape stripping ─────────────────────────────────────────────────────

const ANSI_PATTERN = /\x1b(?:\[[0-9;]*m|\][^\x1b]*\x1b\\)/g;

/** Return the visible (non-ANSI) character count of a string. */
function visibleWidth(s: string): number {
  return s.replace(ANSI_PATTERN, '').length;
}

// ── Border characters ─────────────────────────────────────────────────────────

interface BorderSet {
  topLeft: string; top: string; topMid: string; topRight: string;
  midLeft: string; mid: string; midMid: string; midRight: string;
  botLeft: string; bot: string; botMid: string; botRight: string;
  vert: string;
}

const UNICODE: BorderSet = {
  topLeft: '┌', top: '─', topMid: '┬', topRight: '┐',
  midLeft: '├', mid: '─', midMid: '┼', midRight: '┤',
  botLeft: '└', bot: '─', botMid: '┴', botRight: '┘',
  vert: '│',
};

const ASCII: BorderSet = {
  topLeft: '+', top: '-', topMid: '+', topRight: '+',
  midLeft: '+', mid: '-', midMid: '+', midRight: '+',
  botLeft: '+', bot: '-', botMid: '+', botRight: '+',
  vert: '|',
};

// ── Column width resolution ───────────────────────────────────────────────────

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

/** Resolve the content-width (excluding padding) of each column. */
function resolveWidths(
  columns: TableColumn[],
  rows: Array<Record<string, string>>,
  availableWidth: number,
  padding: number,
  border: BorderStyle
): number[] {
  const colCount = columns.length;
  const borderCost = border !== 'none' ? colCount + 1 : 0; // │ between + edges
  const padCost = colCount * padding * 2; // left+right pad per column
  const interior = availableWidth - borderCost - padCost;

  // Natural widths: max of header length and content length
  const naturalWidths = columns.map((col, i) => {
    const headerW = visibleWidth(col.header);
    const contentW = rows.reduce((acc, row) => {
      return Math.max(acc, visibleWidth(row[col.key] ?? ''));
    }, 0);
    const raw = Math.max(headerW, contentW);
    const min = col.minWidth ?? 1;
    const max = col.maxWidth ?? Infinity;
    return clamp(raw, min, max);
  });

  // If everything fits, return as-is
  const totalNatural = naturalWidths.reduce((a, b) => a + b, 0);
  if (totalNatural <= interior) {
    // Grow flex columns to fill remaining space
    const flexCount = columns.filter((c) => c.flex).length;
    if (flexCount > 0) {
      const extra = Math.floor((interior - totalNatural) / flexCount);
      return naturalWidths.map((w, i) => (columns[i]?.flex ? w + extra : w));
    }
    return naturalWidths;
  }

  // Shrink proportionally, respecting minWidth
  const shrinkable = columns.map((c, i) => {
    const min = c.minWidth ?? 1;
    return Math.max(0, naturalWidths[i]! - min);
  });
  const totalShrinkable = shrinkable.reduce((a, b) => a + b, 0);
  const overage = totalNatural - interior;
  return naturalWidths.map((w, i) => {
    const col = columns[i]!;
    const min = col.minWidth ?? 1;
    const share = totalShrinkable > 0 ? (shrinkable[i]! / totalShrinkable) * overage : 0;
    return Math.max(min, Math.round(w - share));
  });
}

// ── Cell padding ──────────────────────────────────────────────────────────────

function padCell(text: string, width: number, align: Align): string {
  const w = visibleWidth(text);
  if (w >= width) return text.slice(0, width); // truncate if over
  const pad = width - w;
  if (align === 'right') return ' '.repeat(pad) + text;
  if (align === 'center') {
    const left = Math.floor(pad / 2);
    return ' '.repeat(left) + text + ' '.repeat(pad - left);
  }
  return text + ' '.repeat(pad);
}

// ── Row building ──────────────────────────────────────────────────────────────

function buildRow(
  cells: string[],
  colWidths: number[],
  columns: TableColumn[],
  padding: number,
  b: BorderSet | null
): string {
  const pad = ' '.repeat(padding);
  const parts = cells.map((cell, i) => {
    const align = columns[i]?.align ?? 'left';
    return pad + padCell(cell, colWidths[i]!, align) + pad;
  });
  if (b === null) return parts.join('');
  return b.vert + parts.join(b.vert) + b.vert;
}

function buildHRule(
  colWidths: number[],
  padding: number,
  left: string,
  mid: string,
  sep: string,
  right: string
): string {
  const segments = colWidths.map((w) => mid.repeat(w + padding * 2));
  return left + segments.join(sep) + right;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Render a table to a string.
 *
 * @example
 * ```ts
 * renderTable({
 *   columns: [
 *     { key: 'check', header: 'Check' },
 *     { key: 'status', header: 'Status', align: 'center' },
 *     { key: 'detail', header: 'Detail', flex: true },
 *   ],
 *   rows: [{ check: 'config-valid', status: '✓ pass', detail: '' }],
 * });
 * ```
 */
export function renderTable(opts: RenderTableOptions): string {
  const { columns, rows, padding = 1, border = autoDetectBorder() } = opts;
  const termWidth = opts.width ?? Math.max(60, process.stdout.columns ?? 120);

  if (columns.length === 0) return '';

  const b: BorderSet | null =
    border === 'unicode' ? UNICODE : border === 'ascii' ? ASCII : null;

  const colWidths = resolveWidths(columns, rows, termWidth, padding, border);

  const lines: string[] = [];

  // Top border
  if (b) {
    lines.push(buildHRule(colWidths, padding, b.topLeft, b.top, b.topMid, b.topRight));
  }

  // Header row
  const headerCells = columns.map((c) => c.header);
  lines.push(buildRow(headerCells, colWidths, columns, padding, b));

  // Header separator
  if (b) {
    lines.push(buildHRule(colWidths, padding, b.midLeft, b.mid, b.midMid, b.midRight));
  }

  // Data rows
  for (const row of rows) {
    const cells = columns.map((c) => row[c.key] ?? '');
    lines.push(buildRow(cells, colWidths, columns, padding, b));
  }

  // Bottom border
  if (b) {
    lines.push(buildHRule(colWidths, padding, b.botLeft, b.bot, b.botMid, b.botRight));
  }

  return lines.join('\n');
}

/** Detect whether to use unicode box chars based on platform and TERM. */
export function autoDetectBorder(): BorderStyle {
  if (process.platform === 'win32') {
    const term = process.env['TERM'] ?? '';
    const prog = process.env['TERM_PROGRAM'] ?? '';
    const modern =
      Boolean(process.env['WT_SESSION']) ||
      term.includes('xterm') ||
      term.includes('cygwin') ||
      prog === 'vscode';
    return modern ? 'unicode' : 'ascii';
  }
  return 'unicode';
}

export function getTerminalWidth(minWidth = 60, fallback = 120): number {
  return Math.max(minWidth, process.stdout.columns ?? fallback);
}
