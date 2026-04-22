import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { BlobStore } from './blob-store.js';

describe('BlobStore — extForMime assertion', () => {
  let tmpDir: string;
  let store: BlobStore;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'alduin-blobstore-'));
    store = new BlobStore(':memory:', join(tmpDir, 'blobs'));
  });

  afterEach(() => {
    store.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('saves a known MIME type and produces an extension matching /^\\.[a-z0-9]{1,8}$/', () => {
    const ref = store.save(Buffer.alloc(8, 0), 'image', 'image/png');
    expect(ref.storage_uri).toMatch(/\.png$/);
  });

  it('saves unknown MIME type without an extension (empty string is safe)', () => {
    // 'application/x-custom' is not in the map → ext = ''
    const ref = store.save(Buffer.alloc(4, 0), 'document', 'application/x-custom');
    // Should have no extension appended — UUID is the full basename
    const basename = ref.storage_uri.split('/').pop()!;
    // UUID has no dot except possibly if the ext were added
    const parts = basename.split('.');
    // If no ext, only one part (the UUID); if ext, two parts
    // Unknown MIME → no extension → only the UUID
    expect(parts.length).toBe(1);
  });

  it('all built-in MIME types produce safe extensions', () => {
    const knownMimes = [
      'image/jpeg', 'image/png', 'image/gif', 'image/webp',
      'audio/ogg', 'audio/mpeg', 'audio/wav', 'video/mp4',
      'application/pdf', 'text/plain',
    ];
    const safeExt = /^(?:|\.([a-z0-9]{1,8}))$/;

    for (const mime of knownMimes) {
      const ref = store.save(Buffer.alloc(4, 0), 'document', mime);
      const basename = ref.storage_uri.split('/').pop()!;
      // Strip the UUID prefix (36 chars)
      const ext = basename.slice(36); // uuid is 36 chars; everything after is the ext
      expect(ext).toMatch(safeExt);
    }
  });
});
