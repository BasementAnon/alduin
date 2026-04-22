import { lookup } from 'node:dns/promises';
import ipaddr from 'ipaddr.js';
import { Agent, type Dispatcher } from 'undici';

const UA = 'Alduin/0.1 (+https://github.com/alduin-ai/alduin; bot)';
const MAX_REDIRECTS = 5;
const TIMEOUT_MS = 10_000;
const MAX_BODY_BYTES = 5 * 1024 * 1024; // 5 MB

/**
 * Error thrown when safeFetch rejects a URL for security reasons
 * (private IP, blocked protocol, too many redirects).
 * Callers distinguish this from transient network errors.
 */
export class SSRFBlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SSRFBlockedError';
  }
}

// ── IP classification (via ipaddr.js) ────────────────────────────────────────

/**
 * IPv4 ranges `ipaddr.js` reports as `range()`.
 * Anything other than `'unicast'` is considered unsafe.
 *
 * The library already classifies 10/8, 172.16/12, 192.168/16 (private),
 * 127/8 (loopback), 169.254/16 (linkLocal), 100.64/10 (carrierGradeNat),
 * 224/4 (multicast), 240/4 (reserved), 255.255.255.255 (broadcast),
 * and 0.0.0.0/8 (unspecified).
 */
const SAFE_IPV4_RANGES: ReadonlySet<string> = new Set(['unicast']);

/**
 * IPv6 ranges `ipaddr.js` reports as `range()`.
 * Only plain `'unicast'` addresses are allowed. Everything else —
 * loopback (::1), linkLocal (fe80::/10), multicast (ff00::/8),
 * uniqueLocal (fc00::/7), ipv4Mapped (::ffff:0:0/96), 6to4 (2002::/16),
 * teredo (2001::/32), rfc6052/6145, reserved, unspecified — is blocked.
 */
const SAFE_IPV6_RANGES: ReadonlySet<string> = new Set(['unicast']);

/**
 * Classify a parsed IP address. Returns either `{ ok: true, ip }` for a
 * fetchable address, or `{ ok: false, reason }` with a precise reason
 * suitable for an SSRFBlockedError message.
 *
 * Unwraps IPv4-mapped IPv6 addresses (`::ffff:0:0/96`) and re-checks the
 * inner IPv4 — without this, `::ffff:127.0.0.1` would bypass the loopback
 * check because the IPv6 `range()` returns `'ipv4Mapped'` rather than
 * `'loopback'`.
 */
type ClassifyResult =
  | { ok: true; ip: ipaddr.IPv4 | ipaddr.IPv6 }
  | { ok: false; reason: string };

export function classifyIp(parsed: ipaddr.IPv4 | ipaddr.IPv6): ClassifyResult {
  if (parsed.kind() === 'ipv6') {
    const ipv6 = parsed as ipaddr.IPv6;
    // Unwrap ::ffff:a.b.c.d — check the IPv4 inside
    if (ipv6.isIPv4MappedAddress()) {
      const inner = ipv6.toIPv4Address();
      return classifyIp(inner);
    }
    const range = ipv6.range();
    if (!SAFE_IPV6_RANGES.has(range)) {
      return {
        ok: false,
        reason: `IPv6 address ${ipv6.toNormalizedString()} is in reserved range "${range}"`,
      };
    }
    return { ok: true, ip: ipv6 };
  }

  const ipv4 = parsed as ipaddr.IPv4;
  const range = ipv4.range();
  if (!SAFE_IPV4_RANGES.has(range)) {
    return {
      ok: false,
      reason: `IPv4 address ${ipv4.toString()} is in reserved range "${range}"`,
    };
  }
  return { ok: true, ip: ipv4 };
}

/**
 * Parse a raw address string and classify it. Malformed input is
 * treated as unsafe (fail-closed).
 */
function classifyAddressString(address: string): ClassifyResult {
  let parsed: ipaddr.IPv4 | ipaddr.IPv6;
  try {
    parsed = ipaddr.parse(address);
  } catch {
    return { ok: false, reason: `Unparseable address: ${address}` };
  }
  return classifyIp(parsed);
}

// ── DNS resolver (injectable for testing) ─────────────────────────────────────

export type DnsResolver = (
  hostname: string
) => Promise<Array<{ address: string; family: number }>>;

const defaultResolver: DnsResolver = async (hostname) => {
  const results = await lookup(hostname, { all: true });
  return results;
};

/** The validated, pinned address chosen for a fetch. */
interface PinnedAddress {
  ip: string;
  family: 4 | 6;
}

// ── safeFetch ─────────────────────────────────────────────────────────────────

export interface SafeFetchOptions {
  /** Override DNS resolver (for testing) */
  dnsResolver?: DnsResolver;
  /** Timeout in ms (default 10_000) */
  timeoutMs?: number;
  /** Max body bytes (default 5 MB) */
  maxBodyBytes?: number;
  /** Max redirect hops (default 5) */
  maxRedirects?: number;
  /**
   * When true, the response body is returned as raw bytes (ArrayBuffer)
   * instead of decoded text. Use for binary payloads like images and PDFs.
   */
  binary?: boolean;
}

/**
 * Fetch a URL with SSRF protections.
 *
 * 1. Rejects non-http(s) protocols.
 * 2. Resolves the hostname (once per hop) and rejects any address that
 *    falls outside the public unicast range — including IPv4-mapped IPv6.
 * 3. Pins the chosen IP for the actual connection via an undici
 *    dispatcher whose lookup is overridden, so the runtime cannot
 *    re-resolve to a different (private) address between our check
 *    and the TCP connect (DNS rebinding).
 * 4. Follows redirects manually, re-validating every hop.
 * 5. Caps response body at 5 MB.
 * 6. Sets the Alduin User-Agent.
 *
 * Throws SSRFBlockedError on security rejections.
 * Throws normal errors on network failures (timeout, DNS failure, etc).
 */
export async function safeFetch(
  url: string,
  options: SafeFetchOptions = {}
): Promise<Response> {
  const resolver = options.dnsResolver ?? defaultResolver;
  const timeoutMs = options.timeoutMs ?? TIMEOUT_MS;
  const maxBodyBytes = options.maxBodyBytes ?? MAX_BODY_BYTES;
  const maxRedirects = options.maxRedirects ?? MAX_REDIRECTS;

  let currentUrl = url;
  let hops = 0;

  while (hops <= maxRedirects) {
    // 1. Protocol check
    const parsed = new URL(currentUrl);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new SSRFBlockedError(`Blocked protocol: ${parsed.protocol}`);
    }

    // 2. Resolve + classify, pick one safe IP
    const pinned = await resolveAndValidate(parsed.hostname, resolver);

    // 3. Build a dispatcher that pins the connection to the validated IP.
    //    The URL keeps its original hostname so SNI, Host header, and
    //    certificate validation all see the hostname the caller intended —
    //    only the IP the TCP socket talks to is frozen.
    const dispatcher = buildPinnedDispatcher(pinned);

    // Node's global `fetch` is backed by undici and accepts `dispatcher`
    // at runtime, but @types/jsdom transitively pulls in DOM lib types
    // which make the conditional in @types/node's web-globals/fetch.d.ts
    // collapse `RequestInit` down to the DOM shape (without `dispatcher`).
    // Cast to the undici shape so we can pin the dispatcher safely.
    const fetchInit: RequestInit & { dispatcher?: Dispatcher } = {
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
      headers: { 'User-Agent': UA },
      dispatcher,
    };

    let res: Response;
    try {
      res = await fetch(currentUrl, fetchInit);
    } finally {
      // Release sockets eagerly — each hop gets its own dispatcher.
      void dispatcher.close().catch(() => {});
    }

    // Handle redirects
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get('location');
      if (!location) {
        throw new SSRFBlockedError(`Redirect ${res.status} without Location header`);
      }
      currentUrl = new URL(location, currentUrl).href;
      hops++;
      continue;
    }

    // 4. Body size cap — stream read with limit
    if (options.binary) {
      const bodyBuffer = await readBinaryBodyWithLimit(res, maxBodyBytes);
      return new Response(bodyBuffer, {
        status: res.status,
        statusText: res.statusText,
        headers: res.headers,
      });
    }

    const body = await readTextBodyWithLimit(res, maxBodyBytes);
    return new Response(body, {
      status: res.status,
      statusText: res.statusText,
      headers: res.headers,
    });
  }

  throw new SSRFBlockedError(`Too many redirects (>${maxRedirects})`);
}

/**
 * Resolve a hostname, classify every returned address, and pick a safe
 * one to pin. Reject if ANY address fails classification — even if some
 * are public — to close the door on DNS responses that include a
 * private record alongside public ones.
 */
async function resolveAndValidate(
  hostname: string,
  resolver: DnsResolver
): Promise<PinnedAddress> {
  // IP literal (either IPv4 dotted or any address with a ':') — skip DNS
  if (ipaddr.isValid(hostname)) {
    const verdict = classifyAddressString(hostname);
    if (!verdict.ok) {
      throw new SSRFBlockedError(`Blocked address: ${verdict.reason}`);
    }
    const family: 4 | 6 = verdict.ip.kind() === 'ipv4' ? 4 : 6;
    return { ip: verdict.ip.toString(), family };
  }

  // Bracketed IPv6 literal from URL.hostname
  if (hostname.startsWith('[') && hostname.endsWith(']')) {
    const inner = hostname.slice(1, -1);
    if (ipaddr.isValid(inner)) {
      const verdict = classifyAddressString(inner);
      if (!verdict.ok) {
        throw new SSRFBlockedError(`Blocked address: ${verdict.reason}`);
      }
      return { ip: verdict.ip.toString(), family: 6 };
    }
  }

  let addresses: Array<{ address: string; family: number }>;
  try {
    addresses = await resolver(hostname);
  } catch (err) {
    throw new Error(
      `DNS lookup failed for ${hostname}: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  if (addresses.length === 0) {
    throw new Error(`DNS lookup returned no addresses for ${hostname}`);
  }

  let firstSafe: PinnedAddress | null = null;
  for (const { address, family } of addresses) {
    const verdict = classifyAddressString(address);
    if (!verdict.ok) {
      throw new SSRFBlockedError(
        `Blocked private IP resolved from ${hostname}: ${verdict.reason}`
      );
    }
    if (!firstSafe) {
      const fam: 4 | 6 = family === 6 || verdict.ip.kind() === 'ipv6' ? 6 : 4;
      firstSafe = { ip: verdict.ip.toString(), family: fam };
    }
  }

  if (!firstSafe) {
    // Shouldn't be reachable — the loop above either throws or sets firstSafe.
    throw new Error(`No usable address resolved from ${hostname}`);
  }
  return firstSafe;
}

/**
 * Build a one-shot undici Agent whose connect.lookup is hard-wired to the
 * validated IP. Any attempt by undici to re-resolve the hostname between
 * our check and the TCP connect (DNS rebinding) falls through to this
 * function and returns the pinned IP instead.
 */
function buildPinnedDispatcher(pinned: PinnedAddress): Dispatcher {
  return new Agent({
    connect: {
      lookup: (
        _hostname: string,
        _options: unknown,
        callback: (
          err: NodeJS.ErrnoException | null,
          address: string,
          family: number
        ) => void
      ): void => {
        callback(null, pinned.ip, pinned.family);
      },
    },
  });
}

/** Read response body as text up to a byte limit */
async function readTextBodyWithLimit(res: Response, maxBytes: number): Promise<string> {
  if (!res.body) return '';

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const chunks: string[] = [];
  let totalBytes = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    totalBytes += value.byteLength;
    if (totalBytes > maxBytes) {
      reader.cancel().catch(() => {});
      throw new SSRFBlockedError(`Response body exceeds ${maxBytes} byte limit`);
    }

    chunks.push(decoder.decode(value, { stream: true }));
  }

  chunks.push(decoder.decode()); // flush
  return chunks.join('');
}

/** Read response body as raw bytes up to a byte limit (no text decoding) */
async function readBinaryBodyWithLimit(res: Response, maxBytes: number): Promise<ArrayBuffer> {
  if (!res.body) return new ArrayBuffer(0);

  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    totalBytes += value.byteLength;
    if (totalBytes > maxBytes) {
      reader.cancel().catch(() => {});
      throw new SSRFBlockedError(`Response body exceeds ${maxBytes} byte limit`);
    }

    chunks.push(value);
  }

  // Concatenate chunks into a single ArrayBuffer
  const result = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result.buffer;
}
