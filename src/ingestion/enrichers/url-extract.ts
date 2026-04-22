import { JSDOM } from 'jsdom';
import { Readability } from '@mozilla/readability';
import type { AttachmentRef } from '../../channels/adapter.js';
import { safeFetch, SSRFBlockedError } from './safe-fetch.js';
import type { SafeFetchOptions } from './safe-fetch.js';

/**
 * Attempt a simple robots.txt check.
 *
 * - Network error (timeout, DNS failure) → allow (as before).
 * - SSRF block (private IP) → disallow explicitly and log.
 * - robots.txt disallow rule → disallow.
 */
async function isAllowedByRobots(
  url: string,
  fetchOpts?: SafeFetchOptions
): Promise<boolean> {
  try {
    const parsed = new URL(url);
    const robotsUrl = `${parsed.protocol}//${parsed.host}/robots.txt`;
    const res = await safeFetch(robotsUrl, { ...fetchOpts, timeoutMs: 5_000 });
    if (!res.ok) return true;
    const text = await res.text();
    return !isDisallowed(text, parsed.pathname);
  } catch (err) {
    if (err instanceof SSRFBlockedError) {
      console.warn(`[url-extract] SSRF blocked robots.txt fetch for: ${url} — ${err.message}`);
      return false;
    }
    return true; // transient network error → allow by default
  }
}

/** Minimal robots.txt parser — checks Alduin UA and wildcard (*) rules */
function isDisallowed(robotsTxt: string, pathname: string): boolean {
  const lines = robotsTxt.split(/\r?\n/);
  let active = false;

  for (const raw of lines) {
    const line = raw.replace(/#.*$/, '').trim();
    if (!line) continue;

    const lc = line.toLowerCase();
    if (lc.startsWith('user-agent:')) {
      const agent = lc.slice('user-agent:'.length).trim();
      active = agent === '*' || agent.includes('alduin');
    } else if (active && lc.startsWith('disallow:')) {
      const path = line.slice('disallow:'.length).trim();
      if (path && pathname.startsWith(path)) return true;
    }
  }
  return false;
}

export interface URLEnrichmentResult {
  extracted_title?: string;
  extracted_text?: string;
}

/**
 * Fetch a URL, respect robots.txt, extract readable content via Readability.
 * All fetches go through safeFetch with SSRF protections.
 * Returns null when the URL cannot be fetched, is blocked, or can't be parsed.
 *
 * @param fetchOpts - Options forwarded to safeFetch (e.g. mock DNS resolver for tests)
 */
export async function enrichUrl(
  url: string,
  fetchOpts?: SafeFetchOptions
): Promise<URLEnrichmentResult | null> {
  const allowed = await isAllowedByRobots(url, fetchOpts);
  if (!allowed) {
    console.warn(`[url-extract] blocked or disallowed: ${url}`);
    return null;
  }

  let html: string;
  try {
    const res = await safeFetch(url, fetchOpts);
    if (!res.ok) return null;
    html = await res.text();
  } catch (err) {
    if (err instanceof SSRFBlockedError) {
      console.warn(`[url-extract] SSRF blocked: ${url} — ${err.message}`);
    }
    return null;
  }

  try {
    const dom = new JSDOM(html, { url });
    const reader = new Readability(dom.window.document);
    const article = reader.parse();
    if (!article) return null;

    return {
      extracted_title: article.title ?? undefined,
      extracted_text: article.textContent?.trim() ?? undefined,
    };
  } catch {
    return null;
  }
}

/** Enrich an AttachmentRef of kind 'url' */
export async function enrichURLAttachment(
  ref: AttachmentRef,
  fetchOpts?: SafeFetchOptions
): Promise<AttachmentRef['enrichment']> {
  const result = await enrichUrl(ref.storage_uri, fetchOpts);
  if (!result) return undefined;
  return {
    extracted_title: result.extracted_title,
    extracted_text: result.extracted_text,
  };
}
