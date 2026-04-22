import { lookup } from 'node:dns/promises';

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

// ── Private IP range checks ──────────────────────────────────────────────────

/** IPv4 private/reserved ranges */
function isPrivateIPv4(ip: string): boolean {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((p) => isNaN(p))) return true; // malformed → block

  const [a, b, c, d] = parts as [number, number, number, number];

  if (a === 0) return true;                             // 0.0.0.0/8
  if (a === 127) return true;                            // 127.0.0.0/8
  if (a === 10) return true;                             // 10.0.0.0/8
  if (a === 172 && b >= 16 && b <= 31) return true;      // 172.16.0.0/12
  if (a === 192 && b === 168) return true;               // 192.168.0.0/16
  if (a === 169 && b === 254) return true;               // 169.254.0.0/16 (link-local / AWS metadata)

  return false;
}

/** IPv6 private/reserved addresses */
function isPrivateIPv6(ip: string): boolean {
  const normalized = ip.toLowerCase();
  if (normalized === '::1') return true;                       // loopback
  if (normalized.startsWith('fc') || normalized.startsWith('fd')) return true; // fc00::/7
  if (normalized.startsWith('fe80')) return true;               // fe80::/10
  if (normalized === '::') return true;                        // unspecified
  return false;
}

/** Check whether any resolved address is private */
function isPrivateIP(ip: string): boolean {
  if (ip.includes(':')) return isPrivateIPv6(ip);
  return isPrivateIPv4(ip);
}

// ── DNS resolver (injectable for testing) ─────────────────────────────────────

export type DnsResolver = (
  hostname: string
) => Promise<Array<{ address: string; family: number }>>;

const defaultResolver: DnsResolver = async (hostname) => {
  const results = await lookup(hostname, { all: true });
  return results;
};

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
 * 1. Rejects non-http(s) protocols
 * 2. Resolves hostname and rejects private/reserved IPs
 * 3. Follows redirects manually, re-validating each hop
 * 4. Caps response body at 5 MB
 * 5. Sets the Alduin User-Agent
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

    // 2. DNS resolution + private IP check
    await validateHost(parsed.hostname, resolver);

    // 3. Fetch with manual redirect handling
    const res = await fetch(currentUrl, {
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
      headers: { 'User-Agent': UA },
    });

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

/** Resolve a hostname and reject if any IP is private/reserved */
async function validateHost(hostname: string, resolver: DnsResolver): Promise<void> {
  // Skip DNS for IP literals — check directly
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(hostname) || hostname.includes(':')) {
    if (isPrivateIP(hostname)) {
      throw new SSRFBlockedError(`Blocked private IP: ${hostname}`);
    }
    return;
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

  for (const { address } of addresses) {
    if (isPrivateIP(address)) {
      throw new SSRFBlockedError(
        `Blocked private IP ${address} resolved from ${hostname}`
      );
    }
  }
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
