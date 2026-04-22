/**
 * Integration test: Telegram photo fixture → AttachmentRef with ocr_text populated.
 * Mocks the download step and OCR enricher to avoid real network/tesseract calls.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Update } from 'grammy/types';
import { BlobStore } from '../../ingestion/blob-store.js';
import { IngestionPipeline, DEFAULT_INGESTION_CONFIG } from '../../ingestion/pipeline.js';
import { parseAndIngestUpdate } from './parse.js';

// Mock OCR enricher at module scope — vi.mock hoisting is only reliable here,
// not inside it() blocks. See: https://vitest.dev/api/vi.html#vi-mock
vi.mock('../../ingestion/enrichers/ocr.js', () => ({
  enrichImageOCR: vi.fn().mockResolvedValue({ ocr_text: 'Hello from OCR' }),
}));

// ── Telegram photo fixture ────────────────────────────────────────────────────

function makePhotoUpdate(): Update {
  return {
    update_id: 1000001,
    message: {
      message_id: 77,
      from: { id: 111, is_bot: false, first_name: 'Alice', username: 'alice' },
      chat: { id: 111, type: 'private', first_name: 'Alice' },
      date: 1700000000,
      caption: 'Check this out',
      photo: [
        { file_id: 'small-id', file_unique_id: 'su1', width: 90, height: 90, file_size: 512 },
        { file_id: 'large-id', file_unique_id: 'su2', width: 800, height: 600, file_size: 51200 },
      ],
    },
  } as unknown as Update;
}

describe('parseAndIngestUpdate (Telegram photo integration)', () => {
  let tmpDir: string;
  let blobStore: BlobStore;
  let pipeline: IngestionPipeline;
  // Minimal 1×1 PNG
  const PNG_BYTES = Buffer.from(
    '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6260000000000200011de60000000049454e44ae426082',
    'hex'
  );

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'alduin-tg-ingest-'));
    blobStore = new BlobStore(':memory:', join(tmpDir, 'blobs'));
    pipeline = new IngestionPipeline(
      blobStore,
      { ...DEFAULT_INGESTION_CONFIG, ocr_enabled: true },
    );
  });

  afterEach(() => {
    blobStore.close();
    rmSync(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it('produces a NormalizedEvent with a real AttachmentRef after ingestion', async () => {
    // Mock Telegram getFile + file download
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (url: string) => {
      if (String(url).includes('getFile')) {
        return {
          ok: true,
          json: async () => ({ ok: true, result: { file_path: 'photos/file_0.jpg' } }),
        };
      }
      if (String(url).includes('/file/bot')) {
        return {
          ok: true,
          arrayBuffer: async () => PNG_BYTES.buffer,
        };
      }
      throw new Error(`Unexpected fetch: ${url as string}`);
    }));

    const event = await parseAndIngestUpdate(
      makePhotoUpdate(),
      pipeline,
      { telegram: { bot_token: '123456789:TEST-token_abc' } },
      5000
    );

    expect(event).not.toBeNull();
    expect(event!.kind).toBe('file');
    expect(event!.attachments).toHaveLength(1);

    const att = event!.attachments![0]!;
    // Should NOT be a stub anymore
    expect(att.storage_uri).not.toContain('telegram-file://');
    expect(att.bytes).toBeGreaterThan(0);
    // OCR enrichment should be present
    expect(att.enrichment?.ocr_text).toBe('Hello from OCR');
  });

  it('falls back to stub when download fails (attachment timeout path)', async () => {
    // Never resolve — simulate timeout
    vi.stubGlobal('fetch', vi.fn().mockImplementation(() => new Promise(() => {})));

    const event = await parseAndIngestUpdate(
      makePhotoUpdate(),
      pipeline,
      { telegram: { bot_token: 'test-token' } },
      50 // very short timeout to force fallback
    );

    // Event should still be emitted with the original stub
    expect(event).not.toBeNull();
    expect(event!.attachments).toHaveLength(1);
    // Still a stub (download timed out)
    expect(event!.attachments![0]!.storage_uri).toContain('telegram-file://');
  });

  it('returns event unchanged when there are no attachments', async () => {
    const textUpdate: Update = {
      update_id: 999,
      message: {
        message_id: 1,
        from: { id: 42, is_bot: false, first_name: 'Bob' },
        chat: { id: 42, type: 'private', first_name: 'Bob' },
        date: 1700000000,
        text: 'Plain text message',
      },
    } as unknown as Update;

    const event = await parseAndIngestUpdate(
      textUpdate,
      pipeline,
      {},
      5000
    );

    expect(event).not.toBeNull();
    expect(event!.text).toBe('Plain text message');
    expect(event!.attachments).toBeUndefined();
  });
});
