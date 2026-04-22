import { describe, it, expect, vi, afterEach } from 'vitest';
import request from 'supertest';
import { WebhookGateway, parseTrustedProxies, DEFAULT_BIND_HOST } from './gateway.js';
import { DedupeCache } from './dedupe.js';
import type { ChannelAdapter, RawChannelEvent } from '../channels/adapter.js';

// ── Mock adapter factory ──────────────────────────────────────────────────────

interface MockAdapterOpts {
  id: string;
  webhookSecret?: string;
  noVerify?: boolean;
}

function makeMockAdapter(opts: MockAdapterOpts): ChannelAdapter & {
  receivedEvents: RawChannelEvent[];
} {
  const events: RawChannelEvent[] = [];
  let handler: ((e: RawChannelEvent) => void) | null = null;

  // verifyWebhookSignature is now REQUIRED on ChannelAdapter.
  // noVerify:true → pass-through (always returns true, no transport to sign).
  // webhookSecret provided → real HMAC-style check against x-secret-token header.
  let verifyWebhookSignature: ChannelAdapter['verifyWebhookSignature'];
  if (opts.noVerify || opts.webhookSecret === undefined) {
    verifyWebhookSignature = (_headers, _body) => true;
  } else {
    const { timingSafeEqual } = require('node:crypto');
    verifyWebhookSignature = (
      headers: Record<string, string | string[] | undefined>,
      _body?: Buffer
    ): boolean => {
      const secret = opts.webhookSecret!;
      const headerVal = headers['x-secret-token'];
      const received = typeof headerVal === 'string' ? headerVal : '';
      if (received.length === 0 || secret.length === 0) return false;
      const a = Buffer.from(secret, 'utf8');
      const b = Buffer.from(received, 'utf8');
      if (a.length !== b.length) return false;
      return timingSafeEqual(a, b);
    };
  }

  const adapter: ChannelAdapter & { receivedEvents: RawChannelEvent[] } = {
    id: opts.id,
    capabilities: {
      supports_edit: false,
      supports_buttons: false,
      supports_threads: false,
      supports_files: false,
      supports_voice: false,
      supports_typing_indicator: false,
      max_message_length: 4096,
      max_attachment_bytes: 0,
      markdown_dialect: 'plain' as const,
    },
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    send: vi.fn().mockResolvedValue({ message_id: 'x', channel: opts.id, thread_id: 't' }),
    edit: vi.fn().mockResolvedValue(undefined),
    onEvent: (fn: (e: RawChannelEvent) => void) => { handler = fn; },
    verifyWebhookSignature,
    get receivedEvents() { return events; },
    dispatchRawEvent: (e: RawChannelEvent) => {
      events.push(e);
      handler?.(e);
    },
  };

  return adapter;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('WebhookGateway', () => {
  afterEach(() => {
    delete process.env['NODE_ENV'];
    delete process.env['ALDUIN_ENV'];
    delete process.env['ALDUIN_ALLOW_UNSIGNED'];
    delete process.env['ALDUIN_TRUST_PROXY'];
  });

  it('returns 404 for an unregistered channel', async () => {
    process.env['ALDUIN_ALLOW_UNSIGNED'] = '1';
    const gw = new WebhookGateway({ rate_limit_capacity: 100 });

    const res = await request(gw.app)
      .post('/webhooks/unknown')
      .send({ hello: 'world' });
    expect(res.status).toBe(404);
  });

  it('deduplicates events with the same update_id', async () => {
    process.env['ALDUIN_ALLOW_UNSIGNED'] = '1';
    const gw = new WebhookGateway({ rate_limit_capacity: 100 });
    gw.registerAdapter(makeMockAdapter({ id: 'testchan', noVerify: true }));

    const body = { update_id: 55555, message: { from: { id: 1 }, chat: { id: 1 } } };
    const first = await request(gw.app).post('/webhooks/testchan').send(body);
    const second = await request(gw.app).post('/webhooks/testchan').send(body);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(second.body).toMatchObject({ status: 'duplicate' });
  });

  it('rate-limits when the bucket is exhausted (user-based key)', async () => {
    process.env['ALDUIN_ALLOW_UNSIGNED'] = '1';
    const gw = new WebhookGateway({ rate_limit_capacity: 2, rate_limit_refill_per_second: 0 });
    gw.registerAdapter(makeMockAdapter({ id: 'testchan', noVerify: true }));

    let lastStatus = 200;
    for (let i = 0; i < 5; i++) {
      const res = await request(gw.app)
        .post('/webhooks/testchan')
        .send({ update_id: 90000 + i, message: { from: { id: 7 } } });
      lastStatus = res.status;
    }
    expect(lastStatus).toBe(429);
  });

  it('rate-limits by IP when payload has no user', async () => {
    process.env['ALDUIN_ALLOW_UNSIGNED'] = '1';
    const gw = new WebhookGateway({ rate_limit_capacity: 2, rate_limit_refill_per_second: 0 });
    gw.registerAdapter(makeMockAdapter({ id: 'testchan', noVerify: true }));

    let lastStatus = 200;
    for (let i = 0; i < 5; i++) {
      const res = await request(gw.app)
        .post('/webhooks/testchan')
        // No message.from field — forces IP-based fallback
        .send({ update_id: 70000 + i, data: 'no-user-field' });
      lastStatus = res.status;
    }
    // All requests come from the same IP (supertest) → share one bucket → 429
    expect(lastStatus).toBe(429);
  });

  it('dispatches events via dispatchRawEvent (typed interface)', async () => {
    process.env['ALDUIN_ALLOW_UNSIGNED'] = '1';
    const gw = new WebhookGateway({ rate_limit_capacity: 100 });
    const adapter = makeMockAdapter({ id: 'custom', noVerify: true });
    gw.registerAdapter(adapter);

    await request(gw.app)
      .post('/webhooks/custom')
      .send({ update_id: 1, text: 'hello' });

    expect(adapter.receivedEvents).toHaveLength(1);
    expect(adapter.receivedEvents[0]!.channel).toBe('custom');
    expect(adapter.receivedEvents[0]!.payload).toMatchObject({ text: 'hello' });
  });

  it('does not crash if adapter has no dispatchRawEvent', async () => {
    const gw = new WebhookGateway({ rate_limit_capacity: 100 });

    // Build an adapter without dispatchRawEvent (but WITH verifyWebhookSignature — now required)
    const bareAdapter: ChannelAdapter = {
      id: 'bare',
      capabilities: {
        supports_edit: false, supports_buttons: false, supports_threads: false,
        supports_files: false, supports_voice: false, supports_typing_indicator: false,
        max_message_length: 4096, max_attachment_bytes: 0, markdown_dialect: 'plain',
      },
      start: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn().mockResolvedValue(undefined),
      send: vi.fn().mockResolvedValue({ message_id: 'x', channel: 'bare', thread_id: 't' }),
      edit: vi.fn().mockResolvedValue(undefined),
      onEvent: vi.fn(),
      verifyWebhookSignature: () => true,
      // No dispatchRawEvent — intentionally omitted
    };
    gw.registerAdapter(bareAdapter);

    const res = await request(gw.app)
      .post('/webhooks/bare')
      .send({ update_id: 99 });

    // Should still return 200 without crashing
    expect(res.status).toBe(200);
  });
});

// ── Signature verification ────────────────────────────────────────────────────

describe('WebhookGateway — signature verification', () => {
  afterEach(() => {
    delete process.env['NODE_ENV'];
    delete process.env['ALDUIN_ENV'];
    delete process.env['ALDUIN_ALLOW_UNSIGNED'];
  });

  it('401 when header is missing (adapter has verification)', async () => {
    const gw = new WebhookGateway({ rate_limit_capacity: 100 });
    gw.registerAdapter(makeMockAdapter({ id: 'secure', webhookSecret: 'correct-secret' }));

    const res = await request(gw.app)
      .post('/webhooks/secure')
      .send({ update_id: 1 });
    expect(res.status).toBe(401);
  });

  it('401 when secret is wrong', async () => {
    const gw = new WebhookGateway({ rate_limit_capacity: 100 });
    gw.registerAdapter(makeMockAdapter({ id: 'secure', webhookSecret: 'correct-secret' }));

    const res = await request(gw.app)
      .post('/webhooks/secure')
      .set('x-secret-token', 'wrong-secret')
      .send({ update_id: 2 });
    expect(res.status).toBe(401);
  });

  it('200 when secret is correct', async () => {
    const gw = new WebhookGateway({ rate_limit_capacity: 100 });
    gw.registerAdapter(makeMockAdapter({ id: 'secure', webhookSecret: 'correct-secret' }));

    const res = await request(gw.app)
      .post('/webhooks/secure')
      .set('x-secret-token', 'correct-secret')
      .send({ update_id: 3 });
    expect(res.status).toBe(200);
  });

  it('pass-through adapter (noVerify) always returns 200 regardless of env', async () => {
    // All adapters now implement verifyWebhookSignature. Adapters with no
    // network transport (CLI, test pass-through) return true unconditionally.
    const gw = new WebhookGateway({ rate_limit_capacity: 100 });
    gw.registerAdapter(makeMockAdapter({ id: 'passthru', noVerify: true }));

    const res = await request(gw.app)
      .post('/webhooks/passthru')
      .send({ update_id: 4 });
    expect(res.status).toBe(200);
  });

  it('adapter returning false → 401, regardless of ALDUIN_ALLOW_UNSIGNED', async () => {
    // ALDUIN_ALLOW_UNSIGNED is a fallback for adapters without transport;
    // once an adapter explicitly returns false from verifyWebhookSignature,
    // the request is rejected — no env-var override.
    process.env['ALDUIN_ALLOW_UNSIGNED'] = '1';
    const gw = new WebhookGateway({ rate_limit_capacity: 100 });
    // Secret-checking adapter; wrong/missing header → returns false
    gw.registerAdapter(makeMockAdapter({ id: 'strict', webhookSecret: 'my-secret' }));

    const res = await request(gw.app)
      .post('/webhooks/strict')
      .send({ update_id: 5 });
    expect(res.status).toBe(401);
  });

  it('emits a startup warning when ALDUIN_ALLOW_UNSIGNED=1 is set', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => { /* suppress */ });
    process.env['ALDUIN_ALLOW_UNSIGNED'] = '1';

    new WebhookGateway({ rate_limit_capacity: 100 });

    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('ALDUIN_ALLOW_UNSIGNED=1'));
    warnSpy.mockRestore();
  });

  it('ALDUIN_ALLOW_UNSIGNED=1 does NOT bypass adapter verification', async () => {
    process.env['ALDUIN_ALLOW_UNSIGNED'] = '1';
    const gw = new WebhookGateway({ rate_limit_capacity: 100 });
    gw.registerAdapter(makeMockAdapter({ id: 'secure', webhookSecret: 'my-secret' }));

    const res = await request(gw.app)
      .post('/webhooks/secure')
      .send({ update_id: 7 });
    expect(res.status).toBe(401);
  });

  it('rejects secrets of different lengths', async () => {
    const gw = new WebhookGateway({ rate_limit_capacity: 100 });
    gw.registerAdapter(makeMockAdapter({ id: 'secure', webhookSecret: 'short' }));

    const res = await request(gw.app)
      .post('/webhooks/secure')
      .set('x-secret-token', 'much-longer-secret-that-doesnt-match')
      .send({ update_id: 8 });
    expect(res.status).toBe(401);
  });
});

// ── DedupeCache — bounded LRU ─────────────────────────────────────────────────

describe('DedupeCache', () => {
  it('stops growing past maxSize (LRU eviction)', () => {
    const cache = new DedupeCache(60_000, 5);

    for (let i = 0; i < 10; i++) {
      cache.isDuplicate(`event-${i}`);
    }

    expect(cache.size).toBe(5);
    cache.close();
  });

  it('evicts the LRU entry when capacity is reached', () => {
    const cache = new DedupeCache(60_000, 3);

    // Fill to capacity — LRU order: [a, b, c]
    cache.isDuplicate('a');
    cache.isDuplicate('b');
    cache.isDuplicate('c');
    expect(cache.size).toBe(3);

    // Refresh 'a' → LRU order becomes [b, c, a]
    expect(cache.isDuplicate('a')).toBe(true);

    // Insert 'd' → 'b' is LRU and must be evicted; result: [c, a, d]
    expect(cache.isDuplicate('d')).toBe(false);
    expect(cache.size).toBe(3);

    // 'c', 'a', 'd' are still cached
    expect(cache.isDuplicate('c')).toBe(true);
    expect(cache.isDuplicate('a')).toBe(true);
    expect(cache.isDuplicate('d')).toBe(true);

    // 'b' was evicted: checking it would re-insert it, so verify size stays bounded
    expect(cache.size).toBe(3);

    cache.close();
  });

  it('returns true for genuine duplicates', () => {
    const cache = new DedupeCache(60_000, 100);

    expect(cache.isDuplicate('evt-1')).toBe(false); // first time: not a dup
    expect(cache.isDuplicate('evt-1')).toBe(true);  // second time: duplicate
    expect(cache.isDuplicate('evt-2')).toBe(false);
    expect(cache.isDuplicate('evt-2')).toBe(true);

    cache.close();
  });

  it('close() cancels the sweep interval', () => {
    const spy = vi.spyOn(globalThis, 'clearInterval');
    const cache = new DedupeCache();
    cache.close();
    expect(spy).toHaveBeenCalledOnce();
    spy.mockRestore();
  });

  it('close() is idempotent', () => {
    const cache = new DedupeCache();
    expect(() => { cache.close(); cache.close(); }).not.toThrow();
  });
});

// ── H-3: parseTrustedProxies + bind-host default ─────────────────────────────

describe('parseTrustedProxies (H-3)', () => {
  it('returns null for undefined / empty input (no trust)', () => {
    expect(parseTrustedProxies(undefined)).toBeNull();
    expect(parseTrustedProxies('')).toBeNull();
    expect(parseTrustedProxies('   ')).toBeNull();
  });

  it('parses a comma-separated list of IPs and CIDRs', () => {
    expect(parseTrustedProxies('10.0.0.0/8,192.168.1.1')).toEqual([
      '10.0.0.0/8',
      '192.168.1.1',
    ]);
  });

  it('trims surrounding whitespace on each entry', () => {
    expect(parseTrustedProxies(' 10.0.0.1 , 10.0.0.2 ')).toEqual([
      '10.0.0.1',
      '10.0.0.2',
    ]);
  });

  it('rejects bare "true" with a descriptive error (IP-spoofing guard)', () => {
    expect(() => parseTrustedProxies('true')).toThrow(/refuses "true"/);
  });

  it('rejects "*" with a descriptive error (IP-spoofing guard)', () => {
    expect(() => parseTrustedProxies('*')).toThrow(/refuses "true"\/"\*"/);
  });

  it('filters out empty segments produced by trailing commas', () => {
    expect(parseTrustedProxies('10.0.0.1,,10.0.0.2,')).toEqual([
      '10.0.0.1',
      '10.0.0.2',
    ]);
  });

  it('returns null when the trimmed list has no entries left', () => {
    expect(parseTrustedProxies(',,,')).toBeNull();
  });
});

describe('DEFAULT_BIND_HOST (H-3)', () => {
  it('defaults to loopback so the server is not internet-exposed by accident', () => {
    expect(DEFAULT_BIND_HOST).toBe('127.0.0.1');
  });
});
