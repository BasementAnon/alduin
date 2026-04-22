import { resolve as pathResolve, sep as pathSep } from 'node:path';
import { realpathSync } from 'node:fs';
import type { AttachmentRef } from '../channels/adapter.js';
import { BlobStore } from './blob-store.js';
import { enrichImageOCR } from './enrichers/ocr.js';
import { enrichAudioSTT } from './enrichers/stt.js';
import { enrichURLAttachment } from './enrichers/url-extract.js';
import { enrichPDF } from './enrichers/pdf-text.js';
import { safeFetch, SSRFBlockedError } from './enrichers/safe-fetch.js';

/** Configuration for the ingestion pipeline */
export interface IngestionConfig {
  /** Maximum allowed file size in bytes (default 25 MB) */
  max_bytes: number;
  /** Enable OCR for images (requires tesseract.js to be installed) */
  ocr_enabled: boolean;
  /** Enable STT for voice/audio (requires OpenAI API key) */
  stt_enabled: boolean;
  /** Per-attachment ingestion timeout in ms (default 30s) */
  attachment_timeout_ms: number;
  /** Blob TTL in hours (default 24) */
  ttl_hours: number;
  /** Allowlist root for local file ingestion (default './uploads') */
  local_root: string;
}

export const DEFAULT_INGESTION_CONFIG: IngestionConfig = {
  max_bytes: 25 * 1024 * 1024, // 25 MB
  ocr_enabled: false,
  stt_enabled: false,
  attachment_timeout_ms: 30_000,
  ttl_hours: 24,
  local_root: './uploads',
};

/** Per-channel configuration for downloading attachments */
export interface ChannelDownloadConfig {
  telegram?: {
    bot_token: string;
    bot_api_url?: string;
  };
}

export type GateSizeError = { kind: 'size_exceeded'; bytes: number; max_bytes: number };
export type GateMimeError = { kind: 'mime_not_allowed'; mime: string };
export type DownloadError = { kind: 'download_failed'; reason: string };
export type PipelineError = GateSizeError | GateMimeError | DownloadError;

export interface PipelineResult {
  ok: boolean;
  ref?: AttachmentRef;
  error?: PipelineError;
}

const TELEGRAM_FILE_API = 'https://api.telegram.org';

/** MIME types not acceptable for ingestion */
const BLOCKED_MIMES = new Set([
  'application/x-executable',
  'application/x-msdownload',
  'application/x-sh',
  'application/x-bat',
]);

/**
 * The ingestion pipeline normalizes raw channel attachment stubs into
 * fully-enriched AttachmentRefs.
 *
 * Stages: download → size gate → MIME detect → store → enrich
 */
export class IngestionPipeline {
  private blobStore: BlobStore;
  private config: IngestionConfig;
  private openaiApiKey: string | undefined;

  constructor(
    blobStore: BlobStore,
    config: IngestionConfig = DEFAULT_INGESTION_CONFIG,
    openaiApiKey?: string
  ) {
    this.blobStore = blobStore;
    this.config = config;
    this.openaiApiKey = openaiApiKey;
  }

  /**
   * Process a raw attachment stub through all pipeline stages.
   * The stub's storage_uri encodes the channel-native file reference.
   *
   * @param stub           - Stub AttachmentRef from the parser
   * @param channelConfig  - Channel-specific download credentials
   */
  async ingest(
    stub: AttachmentRef,
    channelConfig?: ChannelDownloadConfig
  ): Promise<PipelineResult> {
    // ── 1. Download ──────────────────────────────────────────────────────────
    const downloadResult = await this.download(stub, channelConfig);
    if (!downloadResult.ok) {
      return { ok: false, error: downloadResult.error };
    }
    const buffer = downloadResult.buffer!;

    // ── 2. Size gate ─────────────────────────────────────────────────────────
    if (buffer.length > this.config.max_bytes) {
      return {
        ok: false,
        error: {
          kind: 'size_exceeded',
          bytes: buffer.length,
          max_bytes: this.config.max_bytes,
        },
      };
    }

    // ── 3. Content-type detect via magic bytes ────────────────────────────────
    const detectedMime = await detectMime(buffer, stub.mime);

    if (BLOCKED_MIMES.has(detectedMime)) {
      return {
        ok: false,
        error: { kind: 'mime_not_allowed', mime: detectedMime },
      };
    }

    // ── 4. Store ──────────────────────────────────────────────────────────────
    const ref = this.blobStore.save(
      buffer,
      stub.kind,
      detectedMime,
      this.config.ttl_hours
    );

    // ── 5. Enrich ─────────────────────────────────────────────────────────────
    const enrichment = await this.enrich(ref);
    if (enrichment) {
      this.blobStore.updateEnrichment(ref.attachment_id, enrichment);
      ref.enrichment = enrichment;
    }

    return { ok: true, ref };
  }

  /**
   * Download raw bytes from a channel-native reference.
   * Telegram stubs have URIs like `telegram-file://<file_id>`.
   */
  private async download(
    stub: AttachmentRef,
    channelConfig?: ChannelDownloadConfig
  ): Promise<{ ok: true; buffer: Buffer } | { ok: false; error: DownloadError }> {
    const uri = stub.storage_uri;

    // ── Telegram ──────────────────────────────────────────────────────────────
    if (uri.startsWith('telegram-file://')) {
      const fileId = uri.slice('telegram-file://'.length);
      const token = channelConfig?.telegram?.bot_token;
      if (!token) {
        return {
          ok: false,
          error: { kind: 'download_failed', reason: 'No Telegram bot token configured' },
        };
      }
      const apiBase = channelConfig?.telegram?.bot_api_url ?? TELEGRAM_FILE_API;
      return downloadTelegramFile(apiBase, token, fileId);
    }

    // ── Generic HTTP/HTTPS URL ─────────────────────────────────────────────────
    if (uri.startsWith('http://') || uri.startsWith('https://')) {
      return downloadUrl(uri, this.config.max_bytes);
    }

    // ── Local file (gated, sandboxed to local_root) ─────────────────────────────
    if (uri.startsWith('/') || uri.startsWith('./') || uri.startsWith('../')) {
      if (process.env['ALDUIN_ALLOW_LOCAL_INGESTION'] !== '1') {
        return {
          ok: false,
          error: { kind: 'download_failed', reason: 'Local file ingestion disabled' },
        };
      }

      const validationResult = validateLocalPath(uri, this.config.local_root);
      if (!validationResult.ok) {
        return { ok: false, error: validationResult.error };
      }

      try {
        const { readFileSync } = await import('node:fs');
        return { ok: true, buffer: readFileSync(validationResult.resolvedPath) };
      } catch (e) {
        return {
          ok: false,
          error: { kind: 'download_failed', reason: e instanceof Error ? e.message : String(e) },
        };
      }
    }

    return {
      ok: false,
      error: { kind: 'download_failed', reason: `Unsupported URI scheme: ${uri}` },
    };
  }

  /**
   * Dispatch enrichment by kind.
   * All enrichers are optional — failures produce a warning, not an error.
   */
  private async enrich(ref: AttachmentRef): Promise<AttachmentRef['enrichment']> {
    switch (ref.kind) {
      case 'image':
        return this.config.ocr_enabled ? enrichImageOCR(ref) : undefined;

      case 'voice':
      case 'audio':
        return this.config.stt_enabled && this.openaiApiKey
          ? enrichAudioSTT(ref, this.openaiApiKey)
          : undefined;

      case 'document':
        if (ref.mime === 'application/pdf') return enrichPDF(ref);
        return undefined;

      case 'url':
        return enrichURLAttachment(ref);

      default:
        return undefined;
    }
  }
}

// ── Helper: detect MIME type from magic bytes ─────────────────────────────────

async function detectMime(buffer: Buffer, fallback: string): Promise<string> {
  try {
    const { fileTypeFromBuffer } = await import('file-type');
    const result = await fileTypeFromBuffer(buffer);
    return result?.mime ?? fallback;
  } catch {
    return fallback;
  }
}

// ── Helper: download a Telegram file ─────────────────────────────────────────

const TELEGRAM_TOKEN_RE = /^[0-9]+:[A-Za-z0-9_-]+$/;

/**
 * Strip Telegram bot tokens from arbitrary text.
 *
 * M-8: the real bot token has to appear in both getFile and file-download
 * URLs, so a fetch-layer error (DNS failure, timeout, non-2xx whose URL
 * Node echoes back in the message) can drag it into log output. This
 * helper replaces `bot<numeric>:<secret>` with `bot[REDACTED]` so error
 * strings can be safely included in return values, trace events, or
 * console output.
 *
 * Exported so downstream logging paths (and tests) can apply the same
 * redaction to anything derived from a Telegram-download failure.
 */
export function redactTelegramToken(input: string): string {
  // Match `bot` followed by the Telegram token shape. We intentionally use
  // the same character class (digits, letters, `_`, `-`) as TELEGRAM_TOKEN_RE
  // plus `:` so we don't over-eat surrounding context like a trailing
  // slash or query string.
  return input.replace(/bot[0-9]+:[A-Za-z0-9_-]+/g, 'bot[REDACTED]');
}

async function downloadTelegramFile(
  apiBase: string,
  token: string,
  fileId: string
): Promise<{ ok: true; buffer: Buffer } | { ok: false; error: DownloadError }> {
  if (!TELEGRAM_TOKEN_RE.test(token)) {
    return { ok: false, error: { kind: 'download_failed', reason: 'Invalid Telegram bot token format' } };
  }

  try {
    // Step 1: getFile → file_path
    const getFileRes = await fetch(
      `${apiBase}/bot${token}/getFile?file_id=${encodeURIComponent(fileId)}`,
      { signal: AbortSignal.timeout(10_000) },
    );
    if (!getFileRes.ok) {
      return { ok: false, error: { kind: 'download_failed', reason: `getFile returned ${getFileRes.status}` } };
    }
    const getFileJson = await getFileRes.json() as { ok: boolean; result?: { file_path?: string } };
    const filePath = getFileJson.result?.file_path;
    if (!filePath) {
      return { ok: false, error: { kind: 'download_failed', reason: 'No file_path in getFile response' } };
    }

    // Step 2: download file — encode each path segment but preserve separators
    const encodedFilePath = filePath.split('/').map(encodeURIComponent).join('/');
    const fileRes = await fetch(`${apiBase}/file/bot${token}/${encodedFilePath}`, {
      signal: AbortSignal.timeout(30_000),
    });
    if (!fileRes.ok) {
      return { ok: false, error: { kind: 'download_failed', reason: `File download returned ${fileRes.status}` } };
    }
    const arrayBuffer = await fileRes.arrayBuffer();
    return { ok: true, buffer: Buffer.from(arrayBuffer) };
  } catch (e) {
    // Redact the bot token before it can land in logs/traces. Node's
    // fetch implementation sometimes includes the request URL verbatim
    // in error messages (ECONNREFUSED, getaddrinfo failures, TLS errors),
    // and that URL contains `bot<TOKEN>`.
    const raw = e instanceof Error ? e.message : String(e);
    return {
      ok: false,
      error: { kind: 'download_failed', reason: redactTelegramToken(raw) },
    };
  }
}

async function downloadUrl(
  url: string,
  maxBytes: number
): Promise<{ ok: true; buffer: Buffer } | { ok: false; error: DownloadError }> {
  try {
    const res = await safeFetch(url, {
      binary: true,
      timeoutMs: 30_000,
      maxBodyBytes: maxBytes,
    });
    if (!res.ok) {
      return { ok: false, error: { kind: 'download_failed', reason: `HTTP ${res.status}` } };
    }
    const ab = await res.arrayBuffer();
    return { ok: true, buffer: Buffer.from(ab) };
  } catch (e) {
    if (e instanceof SSRFBlockedError) {
      return {
        ok: false,
        error: { kind: 'download_failed', reason: `SSRF blocked: ${e.message}` },
      };
    }
    return {
      ok: false,
      error: { kind: 'download_failed', reason: e instanceof Error ? e.message : String(e) },
    };
  }
}

/**
 * Validate that a local file path is within the configured allowlist root.
 * Resolves symlinks via realpathSync and re-checks the resolved path.
 */
function validateLocalPath(
  uri: string,
  localRoot: string
): { ok: true; resolvedPath: string } | { ok: false; error: DownloadError } {
  const resolvedRoot = pathResolve(localRoot);
  const resolvedPath = pathResolve(uri);

  // Check the logical path first (before symlink resolution)
  if (!resolvedPath.startsWith(resolvedRoot + pathSep) && resolvedPath !== resolvedRoot) {
    return {
      ok: false,
      error: {
        kind: 'download_failed',
        reason: `Path "${uri}" is outside the allowed root "${localRoot}"`,
      },
    };
  }

  // Resolve symlinks and re-check to prevent symlink escapes
  let realPath: string;
  try {
    realPath = realpathSync(resolvedPath);
  } catch {
    return {
      ok: false,
      error: { kind: 'download_failed', reason: `Cannot resolve path: ${uri}` },
    };
  }

  let realRoot: string;
  try {
    realRoot = realpathSync(resolvedRoot);
  } catch {
    realRoot = resolvedRoot;
  }

  if (!realPath.startsWith(realRoot + pathSep) && realPath !== realRoot) {
    return {
      ok: false,
      error: {
        kind: 'download_failed',
        reason: `Resolved path escapes the allowed root (symlink escape detected)`,
      },
    };
  }

  return { ok: true, resolvedPath: realPath };
}
