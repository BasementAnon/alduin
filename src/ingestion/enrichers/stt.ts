import { createReadStream } from 'node:fs';
import type { AttachmentRef } from '../../channels/adapter.js';

/**
 * Speech-to-text enricher via OpenAI Whisper.
 * Feature-flagged — enabled only when `config.ingestion.stt_enabled` is true
 * AND an OpenAI API key is available.
 */
export async function enrichAudioSTT(
  ref: AttachmentRef,
  openaiApiKey: string
): Promise<AttachmentRef['enrichment']> {
  if (!openaiApiKey) {
    console.warn('[stt] No OpenAI API key — STT skipped');
    return undefined;
  }

  let OpenAI: typeof import('openai').default;
  try {
    const mod = await import('openai');
    OpenAI = mod.default;
  } catch {
    console.warn('[stt] openai package not available — STT skipped');
    return undefined;
  }

  try {
    const client = new OpenAI({ apiKey: openaiApiKey });
    const transcription = await client.audio.transcriptions.create({
      file: createReadStream(ref.storage_uri) as unknown as File,
      model: 'whisper-1',
    });

    const text = transcription.text?.trim();
    return text && text.length > 0 ? { transcript: text } : undefined;
  } catch (err) {
    console.warn('[stt] STT failed:', err instanceof Error ? err.message : String(err));
    return undefined;
  }
}
