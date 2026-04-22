import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { createHmac } from 'node:crypto';
import { basename, dirname, join } from 'node:path';

export interface AuditEntry {
  timestamp: string;
  actor: string;
  action: string;
  /** Any JSON-serialisable value. Serialised via JSON.stringify on write. */
  old_value?: unknown;
  /** Any JSON-serialisable value. Serialised via JSON.stringify on write. */
  new_value?: unknown;
}

/**
 * Serialise an audit field for log output. Strings are wrapped in quotes,
 * objects/arrays stringified, everything else passed through JSON.stringify.
 * Also strips newlines so one entry always occupies exactly one line —
 * preserving the HMAC chain's line-oriented verification.
 */
function encodeAuditValue(v: unknown): string {
  // JSON.stringify handles strings, numbers, booleans, null, arrays, objects.
  // undefined → undefined (caller must guard); Date → ISO string; BigInt → throws.
  let encoded: string;
  try {
    encoded = JSON.stringify(v);
  } catch {
    encoded = JSON.stringify(String(v));
  }
  // Defensive: strip any literal newlines so a single entry is one line.
  return encoded.replace(/[\r\n]/g, ' ');
}

/** HMAC-SHA-256 of `data` using `key` — returns lowercase hex */
function hmac256(key: string, data: string): string {
  return createHmac('sha256', key).update(data, 'utf8').digest('hex');
}

/** Count non-empty lines in a file without loading the full content into a JS array */
function countLines(filePath: string): number {
  if (!existsSync(filePath)) return 0;
  const raw = readFileSync(filePath, 'utf-8');
  let count = 0;
  for (const line of raw.split('\n')) {
    if (line.trim().length > 0) count++;
  }
  return count;
}

/**
 * Find the next available rotation index for a log file.
 * E.g. if audit.log.1 and audit.log.2 exist, returns 3.
 */
function nextRotationIndex(dir: string, baseName: string): number {
  let max = 0;
  try {
    for (const entry of readdirSync(dir)) {
      const m = entry.match(new RegExp(`^${baseName}\\.(\\d+)$`));
      if (m) max = Math.max(max, parseInt(m[1]!, 10));
    }
  } catch { /* directory may not exist yet */ }
  return max + 1;
}

/** Verify a single segment file (active or archive) */
function verifySegment(
  filePath: string,
  hmacKey: string,
  initialPrevLineHash: string
): { ok: true; finalLineHash: string } | { ok: false; breakPoint: number; line: string } {
  if (!existsSync(filePath)) {
    return { ok: true, finalLineHash: initialPrevLineHash };
  }

  const raw = readFileSync(filePath, 'utf-8');
  const lines = raw.split('\n').filter((l) => l.trim().length > 0);

  if (lines.length === 0) {
    return { ok: true, finalLineHash: initialPrevLineHash };
  }

  let prevLineHash = initialPrevLineHash;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const expectedPrevHash = hmac256(hmacKey, prevLineHash);

    // A well-formed entry has exactly one prev_hash= token. More than one
    // means a crafted actor/action field smuggled the marker through — even
    // if the trailing one matches, the chain is ambiguous and we reject.
    const prevHashCount = (line.match(/prev_hash=/g) ?? []).length;
    if (prevHashCount !== 1) {
      return { ok: false, breakPoint: i + 1, line };
    }

    const match = line.match(/ prev_hash=([0-9a-f]{64})$/);
    if (!match) {
      return { ok: false, breakPoint: i + 1, line };
    }
    if (match[1] !== expectedPrevHash) {
      return { ok: false, breakPoint: i + 1, line };
    }

    prevLineHash = line;
  }

  return { ok: true, finalLineHash: prevLineHash };
}

// ── AuditLog ──────────────────────────────────────────────────────────────────

/**
 * Append-only HMAC-chained audit log with log rotation.
 *
 * Each line ends with `prev_hash=<64 hex chars>`.
 * When the active file exceeds `rotateAtLines`, it is renamed to
 * `audit.log.N` and a new `audit.log` is started with a checkpoint line
 * carrying the final hash of the rotated segment — preserving chain continuity.
 *
 * verify()    — verifies the active segment only (O(active_lines)).
 * verifyAll() — verifies every archived segment in order (O(total_lines)).
 */
export class AuditLog {
  private filePath: string;
  private hmacKey: string;
  private rotateAtLines: number;
  /** Cached hash of the last line written */
  private lastLineHash: string;
  /** Cached line count for the active file */
  private activeLineCount: number;

  constructor(
    filePath = '.alduin/audit.log',
    hmacKey: string,
    rotateAtLines = 10_000
  ) {
    this.filePath = filePath;
    this.hmacKey = hmacKey;
    this.rotateAtLines = rotateAtLines;

    const dir = dirname(filePath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
    } else {
      // Tighten permissions on an existing directory in case it was created
      // earlier without a mode. Best-effort — ignore on Windows.
      try { chmodSync(dir, 0o700); } catch { /* best-effort */ }
    }

    this.lastLineHash = this.readLastLineHash();
    this.activeLineCount = countLines(filePath);
  }

  /** Log an admin action, appending a tamper-evident HMAC chain link */
  log(entry: Omit<AuditEntry, 'timestamp'>): void {
    // Rotate before writing if at or over the threshold
    if (this.activeLineCount >= this.rotateAtLines) {
      this.rotate();
    }

    const full: AuditEntry = {
      timestamp: new Date().toISOString(),
      ...entry,
    };

    const prevHash = hmac256(this.hmacKey, this.lastLineHash);

    // Route actor/action through the same encoder as old/new_value. Otherwise
    // a crafted actor field could embed its own `prev_hash=<64 hex>` sequence
    // and confuse the verifier's line-suffix match.
    const line = [
      `[${full.timestamp}]`,
      `actor=${encodeAuditValue(full.actor)}`,
      `action=${encodeAuditValue(full.action)}`,
      full.old_value !== undefined ? `old=${encodeAuditValue(full.old_value)}` : null,
      full.new_value !== undefined ? `new=${encodeAuditValue(full.new_value)}` : null,
      `prev_hash=${prevHash}`,
    ]
      .filter(Boolean)
      .join(' ');

    appendFileSync(this.filePath, line + '\n', { encoding: 'utf-8', mode: 0o600 });
    // `mode` only applies when appendFileSync creates the file — tighten the
    // existing file explicitly so perms are correct on every call.
    try { chmodSync(this.filePath, 0o600); } catch { /* best-effort */ }
    this.lastLineHash = line;
    this.activeLineCount++;
  }

  /**
   * Verify the HMAC chain of the active log segment only.
   * O(active_segment_size) — fast even when many archives exist.
   */
  verify(): { ok: true } | { ok: false; breakPoint: number; line: string } {
    const result = verifySegment(this.filePath, this.hmacKey, this.readActiveSegmentInitialHash());
    if (!result.ok) return result;
    return { ok: true };
  }

  /**
   * Verify all archived segments plus the active segment in chronological order.
   * Returns the first failure found, or ok if every segment is intact.
   */
  verifyAll(): { ok: true } | { ok: false; segment: string; breakPoint: number; line: string } {
    const archives = this.listArchives(); // sorted oldest→newest

    let prevLineHash = ''; // genesis

    for (const archivePath of archives) {
      const result = verifySegment(archivePath, this.hmacKey, prevLineHash);
      if (!result.ok) {
        return { ok: false, segment: archivePath, breakPoint: result.breakPoint, line: result.line };
      }
      prevLineHash = result.finalLineHash;
    }

    // Verify active segment — its initial prev_hash is the final hash of the
    // last archive (or '' if no archives exist).
    const activeResult = verifySegment(this.filePath, this.hmacKey, prevLineHash);
    if (!activeResult.ok) {
      return {
        ok: false,
        segment: this.filePath,
        breakPoint: activeResult.breakPoint,
        line: activeResult.line,
      };
    }

    return { ok: true };
  }

  // ── private helpers ───────────────────────────────────────────────────────

  /**
   * Rotate the active log: rename it to audit.log.N, then write a new
   * active file starting with a checkpoint line that chains from the old tail.
   */
  private rotate(): void {
    const dir = dirname(this.filePath);
    const base = basename(this.filePath);
    const idx = nextRotationIndex(dir, base);
    const archivePath = join(dir, `${base}.${idx}`);

    renameSync(this.filePath, archivePath);

    // Write checkpoint as the genesis of the new segment.
    // The checkpoint's prev_hash is HMAC(lastLineHash) — same formula as a
    // regular entry — so the chain is unbroken across segments. Use the
    // encoder for each field so the serialisation is symmetric with log().
    const checkpointPrevHash = hmac256(this.hmacKey, this.lastLineHash);
    const checkpointLine =
      `[${new Date().toISOString()}] ` +
      `actor=${encodeAuditValue('system')} ` +
      `action=${encodeAuditValue('log.rotation')} ` +
      `new=${encodeAuditValue(`segment_${idx}`)} ` +
      `prev_hash=${checkpointPrevHash}`;

    writeFileSync(this.filePath, checkpointLine + '\n', { encoding: 'utf-8', mode: 0o600 });
    try { chmodSync(this.filePath, 0o600); } catch { /* best-effort */ }
    this.lastLineHash = checkpointLine;
    this.activeLineCount = 1;
  }

  /**
   * Read the initial prevLineHash that the active segment expects.
   * For the first-ever segment it's '' (genesis).
   * For subsequent segments after rotation it's the last line of the most
   * recent archive — O(last-archive-size), no chain replay needed.
   */
  private readActiveSegmentInitialHash(): string {
    const archives = this.listArchives();
    if (archives.length === 0) return '';

    // Read only the last non-empty line of the most-recent archive.
    // This is the value the checkpoint's prev_hash was built from.
    const lastArchive = archives[archives.length - 1]!;
    try {
      const raw = readFileSync(lastArchive, 'utf-8');
      const lines = raw.split('\n').filter((l) => l.trim().length > 0);
      return lines[lines.length - 1] ?? '';
    } catch {
      return '';
    }
  }

  /** Return the list of archive files sorted oldest → newest */
  private listArchives(): string[] {
    const dir = dirname(this.filePath);
    const base = basename(this.filePath);
    const re = new RegExp(`^${base}\\.(\\d+)$`);

    let files: string[] = [];
    try {
      files = readdirSync(dir)
        .filter((f) => re.test(f))
        .sort((a, b) => {
          const na = parseInt(a.match(re)![1]!, 10);
          const nb = parseInt(b.match(re)![1]!, 10);
          return na - nb;
        })
        .map((f) => join(dir, f));
    } catch { /* directory may not exist */ }

    return files;
  }

  /** Read the last non-empty line of the active file, or '' */
  private readLastLineHash(): string {
    if (!existsSync(this.filePath)) return '';
    const raw = readFileSync(this.filePath, 'utf-8');
    const lines = raw.split('\n').filter((l) => l.trim().length > 0);
    return lines[lines.length - 1] ?? '';
  }
}

// ── Startup verification helper ───────────────────────────────────────────────

/**
 * Verify the active audit log segment on startup. Throws if the chain is broken.
 * For full historical verification call log.verifyAll() separately.
 */
export function verifyAuditLogOrThrow(log: AuditLog): void {
  const result = log.verify();
  if (!result.ok) {
    throw new Error(
      `Audit log integrity check failed at line ${result.breakPoint}.\n` +
      `Tampered line: ${result.line}\n` +
      'The audit log has been modified outside of Alduin. Refusing to start.'
    );
  }
}
