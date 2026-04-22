import { readFileSync } from 'node:fs';
import type { AttachmentRef } from '../../channels/adapter.js';

/**
 * PDF text enricher using pdf-parse.
 * pdf-parse is an optional peer dependency; fails gracefully if not installed.
 */
export async function enrichPDF(
  ref: AttachmentRef
): Promise<AttachmentRef['enrichment']> {
  let pdfParse: (buffer: Buffer) => Promise<{ text: string; numpages: number }>;
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mod = await import('pdf-parse/lib/pdf-parse.js' as any) as any;
    pdfParse = (mod.default ?? mod) as typeof pdfParse;
  } catch {
    // Fallback: try the main export
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const mod = await import('pdf-parse' as any) as any;
      pdfParse = (mod.default ?? mod) as typeof pdfParse;
    } catch {
      console.warn('[pdf-text] pdf-parse not installed — PDF text extraction skipped');
      return undefined;
    }
  }

  try {
    const buffer = readFileSync(ref.storage_uri);
    const data = await pdfParse(buffer);
    return {
      extracted_text: data.text?.trim(),
      page_count: data.numpages,
    };
  } catch (err) {
    console.warn('[pdf-text] PDF parse failed:', err instanceof Error ? err.message : String(err));
    return undefined;
  }
}
