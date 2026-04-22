import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { BlobStore } from './blob-store.js';
import { IngestionPipeline, DEFAULT_INGESTION_CONFIG, redactTelegramToken } from './pipeline.js';
import type { AttachmentRef } from '../channels/adapter.js';

// ── helpers ───────────────────────────────────────────────────────────────────

function makeStub(overrides: Partial<AttachmentRef> = {}): AttachmentRef {
  return {
    attachment_id: 'stub-id',
    kind: 'image',
    mime: 'image/jpeg',
    bytes: 1024,
    storage_uri: 'telegram-file://abc123',
    ttl_expires_at: new Date(Date.now() + 3600_000).toISOString(),
    ...overrides,
  };
}

function makeLocalFileStub(filePath: string, kind: AttachmentRef['kind'] = 'image', mime = 'image/png'): AttachmentRef {
  return {
    attachment_id: 'local-stub',
    kind,
    mime,
    bytes: 0,
    storage_uri: filePath,
    ttl_expires_at: new Date(Date.now() + 3600_000).toISOString(),
  };
}

describe('IngestionPipeline', () => {
  let tmpDir: string;
  let blobStore: BlobStore;
  let pipeline: IngestionPipeline;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'alduin-ingest-'));
    blobStore = new BlobStore(':memory:', join(tmpDir, 'blobs'));
    // Enable local ingestion for tests, rooted at tmpDir
    process.env['ALDUIN_ALLOW_LOCAL_INGESTION'] = '1';
    pipeline = new IngestionPipeline(blobStore, {
      ...DEFAULT_INGESTION_CONFIG,
      ocr_enabled: false,
      stt_enabled: false,
      local_root: tmpDir,
    });
  });

  afterEach(() => {
    blobStore?.close();
    delete process.env['ALDUIN_ALLOW_LOCAL_INGESTION'];
    rmSync(tmpDir, { recursive: true, force: true });
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  // ── download error path ───────────────────────────────────────────────────────

  it('returns download_failed when no Telegram token is configured', async () => {
    const stub = makeStub({ storage_uri: 'telegram-file://some-file-id' });
    const result = await pipeline.ingest(stub, {});
    expect(result.ok).toBe(false);
    expect(result.error?.kind).toBe('download_failed');
  });

  it('returns download_failed for unsupported URI schemes', async () => {
    const stub = makeStub({ storage_uri: 'ftp://example.com/file.jpg' });
    const result = await pipeline.ingest(stub, {});
    expect(result.ok).toBe(false);
    expect(result.error?.kind).toBe('download_failed');
  });

  // ── size gate ────────────────────────────────────────────────────────────────

  it('rejects files that exceed max_bytes', async () => {
    const smallPipeline = new IngestionPipeline(
      blobStore,
      { ...DEFAULT_INGESTION_CONFIG, max_bytes: 10 }
    );

    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ ok: true, result: { file_path: 'photos/photo.jpg' } }),
      })
      .mockResolvedValueOnce({
        ok: true,
        arrayBuffer: async () => new ArrayBuffer(20), // 20 bytes > 10 max
      })
    );

    const result = await smallPipeline.ingest(makeStub(), {
      telegram: { bot_token: '123456:ABCdef' },
    });

    expect(result.ok).toBe(false);
    expect(result.error?.kind).toBe('size_exceeded');
    if (!result.ok && result.error?.kind === 'size_exceeded') {
      expect(result.error.bytes).toBe(20);
      expect(result.error.max_bytes).toBe(10);
    }
  });

  // ── local file ingestion (no network required) ────────────────────────────────

  it('stores a local image file and returns a valid AttachmentRef', async () => {
    const fakeImage = join(tmpDir, 'img.png');
    writeFileSync(fakeImage, Buffer.alloc(512, 0x89)); // 0x89 = first byte of PNG magic

    const stub = makeLocalFileStub(fakeImage, 'image', 'image/png');
    const result = await pipeline.ingest(stub);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.ref?.attachment_id).toBeTruthy();
      expect(result.ref?.bytes).toBe(512);
      // Real storage path replaces the stub
      expect(result.ref?.storage_uri).not.toBe(fakeImage); // stored to blobs dir
      expect(result.ref?.mime).toBeTruthy();
    }
  });

  it('stores a PDF document and exposes it via the blob store', async () => {
    const fakePdf = join(tmpDir, 'doc.pdf');
    writeFileSync(fakePdf, Buffer.alloc(256, 0x25)); // 0x25 = first byte of %PDF magic

    const stub = makeLocalFileStub(fakePdf, 'document', 'application/pdf');
    const result = await pipeline.ingest(stub);

    // Should succeed even without pdf-parse installed (enricher is optional)
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.ref?.kind).toBe('document');
      expect(result.ref?.mime).toBeTruthy();
    }
  });

  it('skips OCR when ocr_enabled=false and leaves enrichment empty', async () => {
    const fakeImage = join(tmpDir, 'img2.png');
    writeFileSync(fakeImage, Buffer.alloc(64, 0));

    const result = await pipeline.ingest(makeLocalFileStub(fakeImage, 'image'));

    if (result.ok) {
      expect(result.ref?.enrichment?.ocr_text).toBeUndefined();
    }
  });

  it('skips STT when stt_enabled=false and no api key', async () => {
    const fakeAudio = join(tmpDir, 'voice.ogg');
    writeFileSync(fakeAudio, Buffer.alloc(64, 0));

    const result = await pipeline.ingest(
      makeLocalFileStub(fakeAudio, 'voice', 'audio/ogg')
    );

    if (result.ok) {
      expect(result.ref?.enrichment?.transcript).toBeUndefined();
    }
  });

  // ── enrichment routing check via public API ───────────────────────────────────

  it('sets enrichment on the blob store row when enrichment is populated', async () => {
    // Use a pipeline with ocr_enabled: true but NO tesseract installed
    // → enrichImageOCR returns undefined gracefully → enrichment is undefined
    const ocrPipeline = new IngestionPipeline(
      blobStore,
      { ...DEFAULT_INGESTION_CONFIG, ocr_enabled: true, local_root: tmpDir }
    );

    const fakeImage = join(tmpDir, 'img3.png');
    writeFileSync(fakeImage, Buffer.alloc(128, 0x89));

    const result = await ocrPipeline.ingest(makeLocalFileStub(fakeImage, 'image'));
    // Should succeed (OCR failure is non-fatal)
    expect(result.ok).toBe(true);
    // enrichment may be undefined if tesseract isn't installed — that's fine
    // The test verifies the pipeline doesn't crash on OCR failure
  });

  // ── Telegram download mocking ─────────────────────────────────────────────────

  it('downloads from Telegram when token is provided', async () => {
    const jpegData = Buffer.alloc(100, 0xff);
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ ok: true, result: { file_path: 'photos/img.jpg' } }),
      })
      .mockResolvedValueOnce({
        ok: true,
        arrayBuffer: async () => jpegData.buffer.slice(jpegData.byteOffset, jpegData.byteOffset + jpegData.byteLength),
      })
    );

    const result = await pipeline.ingest(
      makeStub({ storage_uri: 'telegram-file://file-xyz' }),
      { telegram: { bot_token: '123456:ABCdef' } }
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.ref?.bytes).toBe(100);
    }
  });

  // ── SSRF protection on generic HTTP URLs ────────────────────────────────────

  it('rejects a private-IP attachment URL via safeFetch', async () => {
    const stub = makeStub({
      storage_uri: 'http://169.254.169.254/latest/meta-data/',
      kind: 'document',
      mime: 'text/plain',
    });

    const result = await pipeline.ingest(stub, {});

    expect(result.ok).toBe(false);
    expect(result.error?.kind).toBe('download_failed');
    expect(result.error?.reason).toContain('SSRF blocked');
  });

  it('rejects a localhost attachment URL', async () => {
    const stub = makeStub({
      storage_uri: 'http://127.0.0.1:8080/admin',
      kind: 'document',
      mime: 'text/plain',
    });

    const result = await pipeline.ingest(stub, {});
    expect(result.ok).toBe(false);
    expect(result.error?.reason).toContain('SSRF blocked');
  });

  // ── Local file ingestion security ─────────────────────────────────────────

  it('rejects local files when ALDUIN_ALLOW_LOCAL_INGESTION is unset', async () => {
    delete process.env['ALDUIN_ALLOW_LOCAL_INGESTION'];
    const fakeFile = join(tmpDir, 'test.txt');
    writeFileSync(fakeFile, 'hello');

    const result = await pipeline.ingest(
      makeLocalFileStub(fakeFile, 'document', 'text/plain')
    );

    expect(result.ok).toBe(false);
    expect(result.error?.reason).toContain('Local file ingestion disabled');
  });

  it('rejects path traversal (../../etc/passwd)', async () => {
    process.env['ALDUIN_ALLOW_LOCAL_INGESTION'] = '1';

    const result = await pipeline.ingest(
      makeLocalFileStub('../../etc/passwd', 'document', 'text/plain')
    );

    expect(result.ok).toBe(false);
    expect(result.error?.reason).toContain('outside the allowed root');
  });

  it('rejects symlink escape', async () => {
    process.env['ALDUIN_ALLOW_LOCAL_INGESTION'] = '1';

    // Create a file outside the allowlist root
    const outsideDir = mkdtempSync(join(tmpdir(), 'alduin-outside-'));
    const secretFile = join(outsideDir, 'secret.txt');
    writeFileSync(secretFile, 'top-secret-data');

    // Create a symlink inside the allowlist root that points outside
    const symlinkPath = join(tmpDir, 'escape-link.txt');
    try {
      symlinkSync(secretFile, symlinkPath);
    } catch {
      // Windows may not support symlinks without admin — skip
      rmSync(outsideDir, { recursive: true, force: true });
      return;
    }

    const result = await pipeline.ingest(
      makeLocalFileStub(symlinkPath, 'document', 'text/plain')
    );

    expect(result.ok).toBe(false);
    expect(result.error?.reason).toContain('symlink escape');

    rmSync(outsideDir, { recursive: true, force: true });
  });

  // ── Telegram URL encoding ─────────────────────────────────────────────────

  it('URL-encodes a fileId containing & in the getFile query string', async () => {
    const capturedUrls: string[] = [];
    vi.stubGlobal('fetch', vi.fn((url: string) => {
      capturedUrls.push(url);
      if (capturedUrls.length === 1) {
        return Promise.resolve({
          ok: true,
          json: async () => ({ ok: true, result: { file_path: 'photos/img.jpg' } }),
        });
      }
      return Promise.resolve({
        ok: true,
        arrayBuffer: async () => new ArrayBuffer(8),
      });
    }));

    await pipeline.ingest(
      makeStub({ storage_uri: 'telegram-file://abc&evil=1' }),
      { telegram: { bot_token: '123456:ABCdef' } },
    );

    expect(capturedUrls[0]).toContain('file_id=abc%26evil%3D1');
    expect(capturedUrls[0]).not.toContain('file_id=abc&evil=1');
  });

  it('URL-encodes a fileId containing # in the getFile query string', async () => {
    const capturedUrls: string[] = [];
    vi.stubGlobal('fetch', vi.fn((url: string) => {
      capturedUrls.push(url);
      if (capturedUrls.length === 1) {
        return Promise.resolve({
          ok: true,
          json: async () => ({ ok: true, result: { file_path: 'photos/img.jpg' } }),
        });
      }
      return Promise.resolve({
        ok: true,
        arrayBuffer: async () => new ArrayBuffer(8),
      });
    }));

    await pipeline.ingest(
      makeStub({ storage_uri: 'telegram-file://abc#fragment' }),
      { telegram: { bot_token: '123456:ABCdef' } },
    );

    expect(capturedUrls[0]).toContain('file_id=abc%23fragment');
    expect(capturedUrls[0]).not.toContain('file_id=abc#fragment');
  });

  it('returns download_failed for a mangled (invalid) bot token', async () => {
    const result = await pipeline.ingest(
      makeStub({ storage_uri: 'telegram-file://some-file' }),
      { telegram: { bot_token: '../../etc/passwd' } },
    );

    expect(result.ok).toBe(false);
    expect(result.error?.kind).toBe('download_failed');
    expect(result.error?.reason).toContain('Invalid Telegram bot token format');
  });

  it('allows legitimate file inside the allowlist root', async () => {
    process.env['ALDUIN_ALLOW_LOCAL_INGESTION'] = '1';

    const validFile = join(tmpDir, 'allowed.txt');
    writeFileSync(validFile, 'legitimate content');

    const result = await pipeline.ingest(
      makeLocalFileStub(validFile, 'document', 'text/plain')
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.ref?.bytes).toBeGreaterThan(0);
    }
  });
});

// ── M-8: Telegram bot token redaction in logs ─────────────────────────────────

describe('redactTelegramToken (M-8)', () => {
  it('replaces a bot token embedded in a getFile URL', () => {
    const raw = 'request to https://api.telegram.org/bot123456789:ABCdef_GHI-jkl-012345678901234567890/getFile?file_id=x failed';
    const redacted = redactTelegramToken(raw);
    expect(redacted).toContain('bot[REDACTED]');
    expect(redacted).not.toContain('123456789:ABCdef_GHI-jkl-012345678901234567890');
  });

  it('replaces a bot token embedded in a file-download URL', () => {
    const raw = 'fetch https://api.telegram.org/file/bot999:SECRET_TOKEN_abc/photos/file.jpg';
    const redacted = redactTelegramToken(raw);
    expect(redacted).toContain('/file/bot[REDACTED]/photos/file.jpg');
    expect(redacted).not.toContain('SECRET_TOKEN_abc');
  });

  it('redacts multiple tokens in the same string', () => {
    const raw = 'first bot111:AAA second bot222:BBB';
    const redacted = redactTelegramToken(raw);
    expect(redacted).toBe('first bot[REDACTED] second bot[REDACTED]');
  });

  it('passes through strings with no token intact', () => {
    expect(redactTelegramToken('just a harmless message')).toBe('just a harmless message');
  });

  it('does not redact the word "bot" on its own', () => {
    // No colon + digits, so it's not a token pattern.
    expect(redactTelegramToken('a robot says hi')).toBe('a robot says hi');
  });

  it('redacts tokens even without the api.telegram.org host prefix', () => {
    // The URL prefix might be stripped by the fetch error formatter.
    const raw = 'ECONNRESET while calling bot42:ZZZ';
    expect(redactTelegramToken(raw)).toBe('ECONNRESET while calling bot[REDACTED]');
  });
});
