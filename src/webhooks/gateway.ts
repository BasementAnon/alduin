import express, { type Request, type Response, type NextFunction } from 'express';
import type { ChannelAdapter, RawChannelEvent } from '../channels/adapter.js';
import type { TelegramAdapter } from '../channels/telegram/index.js';
import { DedupeCache } from './dedupe.js';

// ── Rate limiter (token bucket) ───────────────────────────────────────────────

interface BucketState {
  tokens: number;
  last_refill_ms: number;
}

class TokenBucket {
  private buckets = new Map<string, BucketState>();
  private capacity: number;
  private refillRate: number;
  private refillIntervalMs: number;

  constructor(capacity = 10, refillRate = 2) {
    this.capacity = capacity;
    this.refillRate = refillRate;
    this.refillIntervalMs = 1000;
  }

  consume(key: string): boolean {
    const now = Date.now();
    let state = this.buckets.get(key);

    if (!state) {
      state = { tokens: this.capacity, last_refill_ms: now };
      this.buckets.set(key, state);
    } else {
      const elapsed = now - state.last_refill_ms;
      const refillCount = Math.floor(elapsed / this.refillIntervalMs) * this.refillRate;
      if (refillCount > 0) {
        state.tokens = Math.min(this.capacity, state.tokens + refillCount);
        state.last_refill_ms = now;
      }
    }

    if (state.tokens < 1) return false;
    state.tokens--;
    return true;
  }
}

// ── Gateway ───────────────────────────────────────────────────────────────────

export interface GatewayConfig {
  rate_limit_capacity?: number;
  rate_limit_refill_per_second?: number;
}

/**
 * Default host the gateway binds on when `ALDUIN_BIND_HOST` is not set.
 *
 * Binding to the loopback address keeps the webhook endpoint off the public
 * interface by default — operators running behind a reverse proxy or tunnel
 * should set `ALDUIN_BIND_HOST=0.0.0.0` (or the specific interface IP) after
 * confirming that network-level access controls are in place.
 */
export const DEFAULT_BIND_HOST = '127.0.0.1';

/**
 * Parse the operator-provided list of trusted proxy addresses/CIDRs.
 *
 * `ALDUIN_TRUSTED_PROXIES` is a comma-separated list (e.g.
 * `10.0.0.0/8,192.168.1.1`). Express's `trust proxy` setting accepts a
 * function, string array, or CIDR string — we pass an array of non-empty
 * trimmed entries. When the env var is empty or unset, returns null and the
 * caller should leave `trust proxy` at its default (disabled).
 *
 * We deliberately refuse the bare value `true` / `*` here: trusting every
 * upstream hop allows `X-Forwarded-For` spoofing and breaks rate limiting.
 * Operators that truly need to trust all proxies must enumerate them.
 */
export function parseTrustedProxies(raw: string | undefined): string[] | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  if (trimmed === 'true' || trimmed === '*') {
    throw new Error(
      'ALDUIN_TRUSTED_PROXIES refuses "true"/"*" — enumerate proxy IPs/CIDRs ' +
        'explicitly (e.g. "10.0.0.0/8,192.168.1.1") to prevent X-Forwarded-For spoofing.'
    );
  }
  const entries = trimmed
    .split(',')
    .map((e) => e.trim())
    .filter((e) => e.length > 0);
  return entries.length > 0 ? entries : null;
}

/**
 * Webhook gateway: single Express app that receives POST /webhooks/:channel.
 *
 * Signature verification is delegated to each adapter's `verifyWebhookSignature`.
 * Rate limiting falls back to request IP when the payload has no parseable user ID.
 * Trust proxy is configured from `ALDUIN_TRUSTED_PROXIES` (comma-separated
 * list of proxy IPs/CIDRs). The legacy `ALDUIN_TRUST_PROXY=1` flag — which
 * set `trust proxy: true` and allowed any upstream to spoof the client IP —
 * has been removed.
 */
export class WebhookGateway {
  readonly app: ReturnType<typeof express>;
  private adapters = new Map<string, ChannelAdapter>();
  /**
   * Per-channel custom handlers (e.g. Grammy's Telegram webhook handler).
   * These run AFTER the shared pre-checks (CORS strip, signature verification,
   * rate limiting, dedup) but REPLACE the generic dispatchRawEvent step.
   * Stored in a map rather than registered as sibling Express routes so that
   * Express 5's first-match-wins semantics don't shadow specific routes with
   * the /webhooks/:channel catch-all.
   */
  private customHandlers = new Map<string, (req: Request, res: Response, next: NextFunction) => void>();
  private rateLimiter: TokenBucket;
  private dedupe: DedupeCache;

  constructor(config: GatewayConfig = {}) {
    this.app = express();

    if (process.env['ALDUIN_ALLOW_UNSIGNED'] === '1') {
      console.warn(
        '[Gateway] WARNING: ALDUIN_ALLOW_UNSIGNED=1 is set. ' +
          'Unsigned webhook requests may be accepted in development mode. ' +
          'Never enable this in production.'
      );
    }

    // Trust proxy is configured from ALDUIN_TRUSTED_PROXIES. Never set
    // `trust proxy: true` — that would let any upstream host spoof the
    // client IP via X-Forwarded-For and bypass per-IP rate limiting.
    const trustedProxies = parseTrustedProxies(process.env['ALDUIN_TRUSTED_PROXIES']);
    if (trustedProxies) {
      this.app.set('trust proxy', trustedProxies);
    }

    this.rateLimiter = new TokenBucket(
      config.rate_limit_capacity ?? 10,
      config.rate_limit_refill_per_second ?? 2
    );
    this.dedupe = new DedupeCache();

    // Webhook endpoints must not be reachable from browsers.
    // Strip any CORS headers so browsers enforce same-origin policy.
    this.app.use((_req: Request, res: Response, next: NextFunction) => {
      res.removeHeader('Access-Control-Allow-Origin');
      res.removeHeader('Access-Control-Allow-Methods');
      res.removeHeader('Access-Control-Allow-Headers');
      next();
    });

    this.app.use(
      express.json({
        limit: '1mb',
        verify: (req: Request, _res: Response, buf: Buffer) => {
          (req as Request & { rawBody?: Buffer }).rawBody = buf;
        },
      })
    );

    this.app.post('/webhooks/:channel', this.handleWebhook.bind(this));
  }

  /** Stop the background sweep timer. Call during graceful shutdown. */
  close(): void {
    this.dedupe.close();
  }

  registerAdapter(adapter: ChannelAdapter): void {
    this.adapters.set(adapter.id, adapter);

    const tgAdapter = adapter as TelegramAdapter;
    if (adapter.id === 'telegram' && typeof tgAdapter.getWebhookHandler === 'function') {
      // Register as a custom handler, not a sibling route. The catch-all
      // at /webhooks/:channel would otherwise shadow this under Express 5.
      this.customHandlers.set('telegram', tgAdapter.getWebhookHandler());
    }
  }

  private handleWebhook(req: Request, res: Response, _next: NextFunction): void {
    const rawChannel = req.params['channel'];
    const channel = Array.isArray(rawChannel) ? rawChannel[0] : rawChannel;
    if (!channel) {
      res.status(400).json({ error: 'Missing channel' });
      return;
    }

    const adapter = this.adapters.get(channel);
    if (!adapter) {
      res.status(404).json({ error: `No adapter for channel: ${channel}` });
      return;
    }

    // Signature verification
    if (!this.verifyRequest(adapter, req)) {
      res.status(401).json({ error: 'Invalid signature' });
      return;
    }

    // Rate limiting — extract user from payload, fall back to request IP
    const rateLimitKey = this.extractRateLimitKey(channel, req.body as unknown, req);
    if (!this.rateLimiter.consume(rateLimitKey)) {
      res.status(429).json({ error: 'Rate limit exceeded' });
      return;
    }

    // Deduplication
    const eventId = this.extractEventId(channel, req.body as unknown);
    if (eventId && this.dedupe.isDuplicate(eventId)) {
      res.status(200).json({ status: 'duplicate' });
      return;
    }

    // If an adapter registered a custom handler (e.g. Grammy's Telegram
    // webhook handler), delegate to it. It's responsible for responding.
    const custom = this.customHandlers.get(channel);
    if (custom) {
      custom(req, res, _next);
      return;
    }

    // Dispatch via the typed interface
    const event: RawChannelEvent = {
      channel,
      received_at: new Date().toISOString(),
      payload: req.body,
    };

    try {
      if (typeof adapter.dispatchRawEvent === 'function') {
        adapter.dispatchRawEvent(event);
      }
    } catch (err) {
      const name = err instanceof Error ? err.name : 'UnknownError';
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[Gateway] Dispatch error: channel=${channel} error=${name}: ${message}`);
    }

    res.status(200).json({ status: 'ok' });
  }

  private verifyRequest(adapter: ChannelAdapter, req: Request): boolean {
    const rawBody = (req as Request & { rawBody?: Buffer }).rawBody;
    return adapter.verifyWebhookSignature(
      req.headers as Record<string, string | string[] | undefined>,
      rawBody,
    );
  }

  /**
   * Whether unsigned webhook requests are permitted.
   *
   * Requires `ALDUIN_ENV=development` (explicit dev declaration) AND
   * `ALDUIN_ALLOW_UNSIGNED=1`. When `ALDUIN_ENV` is unset or any other value,
   * this returns false — defaulting to deny.
   *
   * Note: the `NODE_ENV` variable is intentionally NOT used here because build
   * tools often set `NODE_ENV=production` for tree-shaking purposes even in
   * development environments; `ALDUIN_ENV` is an explicit operator signal.
   */
  private isUnsignedAllowed(): boolean {
    if (process.env['ALDUIN_ENV'] !== 'development') return false;
    return process.env['ALDUIN_ALLOW_UNSIGNED'] === '1';
  }

  /**
   * Build a rate-limit key from the payload, falling back to the request IP.
   * This ensures anonymous or unparseable traffic is rate-limited per source IP
   * rather than sharing one global bucket.
   */
  private extractRateLimitKey(channel: string, body: unknown, req: Request): string {
    if (body && typeof body === 'object') {
      const tgUpdate = body as {
        message?: { from?: { id?: number }; chat?: { id?: number } };
        callback_query?: { from?: { id?: number } };
      };
      const userId =
        tgUpdate.message?.from?.id ??
        tgUpdate.callback_query?.from?.id ??
        tgUpdate.message?.chat?.id;
      if (userId) return `${channel}:${userId}`;
    }
    return `${channel}:ip:${req.ip ?? 'unknown'}`;
  }

  private extractEventId(channel: string, body: unknown): string | null {
    if (!body || typeof body !== 'object') return null;
    const record = body as Record<string, unknown>;
    if (record['update_id'] !== undefined) {
      return `${channel}-${String(record['update_id'])}`;
    }
    if (typeof record['event_id'] === 'string') {
      return `${channel}-${record['event_id']}`;
    }
    return null;
  }
}
