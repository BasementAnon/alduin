import { readFileSync } from 'node:fs';
import type { AttachmentRef } from '../../channels/adapter.js';

/**
 * OCR enricher using tesseract.js.
 * Feature-flagged — enabled only when `config.ingestion.ocr_enabled` is true.
 * tesseract.js is an optional peer dependency; fails gracefully if not installed.
 */
export async function enrichImageOCR(
  ref: AttachmentRef
): Promise<AttachmentRef['enrichment']> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let createWorker: (lang: string, oem?: number, opts?: any) => Promise<any>;
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mod = await import('tesseract.js' as any) as any;
    createWorker = mod.createWorker as typeof createWorker;
  } catch {
    console.warn('[ocr] tesseract.js not installed — OCR skipped');
    return undefined;
  }

  try {
    const worker = await createWorker('eng', 1, {
      logger: () => {}, // suppress progress logs
    });
    const imageBuffer = readFileSync(ref.storage_uri);
    const { data } = await worker.recognize(imageBuffer);
    await worker.terminate();

    const text = data.text.trim();
    return text.length > 0 ? { ocr_text: text } : undefined;
  } catch (err) {
    console.warn('[ocr] OCR failed:', err instanceof Error ? err.message : String(err));
    return undefined;
  }
}
