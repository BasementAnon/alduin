import type { AlduinConfig } from '../config/types.js';

interface ColdEntry {
  sessionId: string;
  summary: string;
  embedding: number[];
  metadata: { date: Date; topics: string[] };
}

const DEFAULT_SIMILARITY_THRESHOLD = 0.7;

/**
 * Cold memory — long-term session storage with similarity search.
 * Uses an in-memory bag-of-words embedding as a placeholder.
 *
 * TODO: Replace generateEmbedding() with real embeddings:
 *   - OpenAI: text-embedding-3-small via the OpenAI SDK
 *   - Local: ollama/nomic-embed-text via fetch to /api/embed
 * The rest of the store/search interface can remain unchanged.
 */
export class ColdMemory {
  private entries: ColdEntry[] = [];
  private embeddingModel: string;
  private similarityThreshold: number;

  constructor(_providerRegistry: unknown, config: AlduinConfig) {
    this.embeddingModel =
      config.memory?.cold_embedding_model ?? 'ollama/nomic-embed-text';
    this.similarityThreshold =
      config.memory?.cold_similarity_threshold ?? DEFAULT_SIMILARITY_THRESHOLD;
  }

  /**
   * Store a session summary with metadata.
   * The embedding is generated from the summary text for later similarity lookup.
   */
  store(
    sessionId: string,
    summary: string,
    metadata: { date: Date; topics: string[] }
  ): void {
    const embedding = this.generateEmbedding(summary);
    this.entries.push({ sessionId, summary, embedding, metadata });
  }

  /**
   * Search for past sessions relevant to the query.
   * Returns up to topK entries whose similarity exceeds the configured threshold,
   * sorted by similarity descending.
   */
  search(
    query: string,
    topK: number = 3
  ): Array<{ sessionId: string; summary: string; similarity: number }> {
    if (this.entries.length === 0) return [];

    const queryEmbedding = this.generateEmbedding(query);

    return this.entries
      .map((entry) => ({
        sessionId: entry.sessionId,
        summary: entry.summary,
        similarity: this.cosineSimilarity(queryEmbedding, entry.embedding),
      }))
      .filter((r) => r.similarity >= this.similarityThreshold)
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, topK);
  }

  /** Remove a session entry by ID */
  delete(sessionId: string): void {
    this.entries = this.entries.filter((e) => e.sessionId !== sessionId);
  }

  /** Remove all stored entries */
  clear(): void {
    this.entries = [];
  }

  /** Number of stored entries */
  size(): number {
    return this.entries.length;
  }

  /**
   * Compute cosine similarity between two vectors.
   * Returns 0 for zero vectors or mismatched dimensions.
   */
  cosineSimilarity(a: number[], b: number[]): number {
    if (a.length === 0 || b.length === 0) return 0;

    // Align to same length (union vocabulary may differ between calls)
    const len = Math.max(a.length, b.length);
    const va = a.length < len ? [...a, ...new Array<number>(len - a.length).fill(0)] : a;
    const vb = b.length < len ? [...b, ...new Array<number>(len - b.length).fill(0)] : b;

    let dot = 0;
    let normA = 0;
    let normB = 0;
    for (let i = 0; i < len; i++) {
      dot += (va[i] ?? 0) * (vb[i] ?? 0);
      normA += (va[i] ?? 0) ** 2;
      normB += (vb[i] ?? 0) ** 2;
    }

    const denom = Math.sqrt(normA) * Math.sqrt(normB);
    return denom === 0 ? 0 : dot / denom;
  }

  /**
   * Generate a bag-of-words frequency vector for a text string.
   * Vocabulary is built from all stored entries + the current text.
   *
   * TODO: Replace with real embeddings (OpenAI text-embedding-3-small or
   * Ollama nomic-embed-text) once the embedding endpoint is wired up.
   */
  private generateEmbedding(text: string): number[] {
    const words = this.tokenize(text);

    // Build vocabulary from stored entries + current text
    const vocab = new Map<string, number>();
    for (const entry of this.entries) {
      for (const w of this.tokenize(entry.summary)) {
        if (!vocab.has(w)) vocab.set(w, vocab.size);
      }
    }
    for (const w of words) {
      if (!vocab.has(w)) vocab.set(w, vocab.size);
    }

    if (vocab.size === 0) return [];

    const vector = new Array<number>(vocab.size).fill(0);
    for (const w of words) {
      const idx = vocab.get(w);
      if (idx !== undefined) vector[idx]++;
    }
    return vector;
  }

  /** Lowercase, split on non-alphanumeric characters, filter empty tokens */
  private tokenize(text: string): string[] {
    return text
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length > 0);
  }
}
