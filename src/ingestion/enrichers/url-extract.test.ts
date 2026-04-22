import { describe, it, expect, vi, afterEach } from 'vitest';
import { enrichUrl } from './url-extract.js';
import { safeFetch, SSRFBlockedError } from './safe-fetch.js';
import type { DnsResolver } from './safe-fetch.js';

// ── Fixture HTML ──────────────────────────────────────────────────────────────

const FIXTURE_HTML = `<!DOCTYPE html>
<html>
<head><title>Test Article</title></head>
<body>
  <article>
    <h1>My Great Article</h1>
    <p>This is the main article content. It has multiple sentences and enough text for Readability to recognize it as the primary content of the page.</p>
    <p>A second paragraph adds more context. Readability needs sufficient text density to extract the article reliably.</p>
  </article>
</body>
</html>`;

// ── Mock DNS resolvers ────────────────────────────────────────────────────────

/** Resolves every hostname to a public IP */
const publicResolver: DnsResolver = async () => [
  { address: '93.184.216.34', family: 4 },
];

/** Resolves every hostname to a loopback IP */
const loopbackResolver: DnsResolver = async () => [
  { address: '127.0.0.1', family: 4 },
];

/** Resolves to a private 10.x address */
const privateResolver: DnsResolver = async () => [
  { address: '10.0.0.1', family: 4 },
];

/** Resolves to an AWS metadata IP */
const metadataResolver: DnsResolver = async () => [
  { address: '169.254.169.254', family: 4 },
];

// ── enrichUrl tests (existing, adapted to use dnsResolver) ────────────────────

describe('enrichUrl', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('extracts title and text from a readable article', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (url: string) => {
      if (String(url).includes('robots.txt')) {
        return new Response('', { status: 404 });
      }
      return new Response(FIXTURE_HTML, { status: 200 });
    }));

    const result = await enrichUrl('https://example.com/article', {
      dnsResolver: publicResolver,
    });

    expect(result).not.toBeNull();
    expect(result!.extracted_title).toContain('Test Article');
    expect(result!.extracted_text).toContain('main article content');
  });

  it('returns null when robots.txt disallows the URL', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (url: string) => {
      if (String(url).includes('robots.txt')) {
        return new Response('User-agent: *\nDisallow: /article', { status: 200 });
      }
      return new Response(FIXTURE_HTML, { status: 200 });
    }));

    const result = await enrichUrl('https://example.com/article', {
      dnsResolver: publicResolver,
    });
    expect(result).toBeNull();
  });

  it('returns null when the HTTP request fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Network error')));
    const result = await enrichUrl('https://example.com/broken', {
      dnsResolver: publicResolver,
    });
    expect(result).toBeNull();
  });

  it('returns null for non-200 responses', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response('', { status: 500 })
    ));
    const result = await enrichUrl('https://example.com/error', {
      dnsResolver: publicResolver,
    });
    expect(result).toBeNull();
  });

  it('allows fetch when robots.txt request itself fails (network error)', async () => {
    let callCount = 0;
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (url: string) => {
      callCount++;
      if (callCount === 1) {
        // robots.txt — network error
        throw new Error('Connection refused');
      }
      // Main page fetch
      return new Response(FIXTURE_HTML, { status: 200 });
    }));

    const result = await enrichUrl('https://example.com/page', {
      dnsResolver: publicResolver,
    });
    expect(result).not.toBeNull();
  });
});

// ── safeFetch SSRF protection tests ───────────────────────────────────────────

describe('safeFetch — SSRF protection', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('allows public IP addresses', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response('hello', { status: 200 })
    ));

    const res = await safeFetch('https://example.com/page', {
      dnsResolver: publicResolver,
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('hello');
  });

  it('blocks 127.0.0.1 (loopback)', async () => {
    await expect(
      safeFetch('https://localhost/secret', { dnsResolver: loopbackResolver })
    ).rejects.toThrow(SSRFBlockedError);
  });

  it('blocks 10.0.0.0/8 (private range)', async () => {
    await expect(
      safeFetch('https://internal.corp/admin', { dnsResolver: privateResolver })
    ).rejects.toThrow(SSRFBlockedError);
  });

  it('blocks 169.254.169.254 (AWS metadata)', async () => {
    await expect(
      safeFetch('http://169.254.169.254/latest/meta-data/', {
        dnsResolver: metadataResolver,
      })
    ).rejects.toThrow(SSRFBlockedError);
  });

  it('blocks IP literal 127.0.0.1 without DNS lookup', async () => {
    await expect(
      safeFetch('http://127.0.0.1:8080/admin', { dnsResolver: publicResolver })
    ).rejects.toThrow(SSRFBlockedError);
  });

  it('blocks non-http protocols', async () => {
    await expect(
      safeFetch('ftp://example.com/file', { dnsResolver: publicResolver })
    ).rejects.toThrow(SSRFBlockedError);

    await expect(
      safeFetch('file:///etc/passwd', { dnsResolver: publicResolver })
    ).rejects.toThrow(SSRFBlockedError);
  });

  it('blocks redirect to private IP at hop 2', async () => {
    let callCount = 0;
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => {
      callCount++;
      if (callCount === 1) {
        // First fetch → redirect to internal host
        return new Response('', {
          status: 302,
          headers: { Location: 'http://evil.internal/admin' },
        });
      }
      return new Response('should not reach here', { status: 200 });
    }));

    // First hop resolves to public, redirect target resolves to private
    const hopResolver: DnsResolver = async (hostname) => {
      if (hostname === 'example.com') {
        return [{ address: '93.184.216.34', family: 4 }];
      }
      // evil.internal resolves to a private IP
      return [{ address: '10.0.0.99', family: 4 }];
    };

    await expect(
      safeFetch('https://example.com/start', { dnsResolver: hopResolver })
    ).rejects.toThrow(SSRFBlockedError);
  });

  it('blocks after too many redirects', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (url: string) => {
      return new Response('', {
        status: 302,
        headers: { Location: String(url) + '/loop' },
      });
    }));

    await expect(
      safeFetch('https://example.com/start', {
        dnsResolver: publicResolver,
        maxRedirects: 3,
      })
    ).rejects.toThrow('Too many redirects');
  });

  it('enrichUrl returns null (not crash) when SSRF-blocked', async () => {
    // Don't stub global fetch — safeFetch will reject before fetch is called
    const result = await enrichUrl('http://169.254.169.254/latest/meta-data/', {
      dnsResolver: metadataResolver,
    });
    expect(result).toBeNull();
  });

  it('isAllowedByRobots returns false (not true) when SSRF-blocked', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    // SSRF block during robots.txt fetch → should return false, not default-allow
    const result = await enrichUrl('http://10.0.0.1/secret', {
      dnsResolver: privateResolver,
    });

    expect(result).toBeNull();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('SSRF blocked')
    );

    warnSpy.mockRestore();
  });

  it('binary mode round-trips bytes without corruption', async () => {
    // Create a buffer with every possible byte value (0x00–0xFF)
    const original = Buffer.alloc(256);
    for (let i = 0; i < 256; i++) original[i] = i;

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response(original, { status: 200 })
    ));

    const res = await safeFetch('https://example.com/binary.bin', {
      dnsResolver: publicResolver,
      binary: true,
    });

    const ab = await res.arrayBuffer();
    const roundTripped = Buffer.from(ab);

    expect(roundTripped.length).toBe(256);
    expect(roundTripped.equals(original)).toBe(true);
  });

  it('text mode corrupts binary bytes (demonstrating why binary mode exists)', async () => {
    // 0xFF bytes are invalid UTF-8 — TextDecoder replaces them with U+FFFD
    const binaryData = Buffer.alloc(4, 0xff);

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response(binaryData, { status: 200 })
    ));

    const res = await safeFetch('https://example.com/binary.bin', {
      dnsResolver: publicResolver,
      // binary: false (default — text mode)
    });

    const text = await res.text();
    // Text mode corrupts the bytes — the replacement character U+FFFD appears
    expect(Buffer.from(text, 'utf-8').equals(binaryData)).toBe(false);
  });
});
