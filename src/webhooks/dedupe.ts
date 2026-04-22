/**
 * Size-bounded LRU deduplication cache for the webhook gateway.
 *
 * - Entries are evicted in least-recently-used order once `maxSize` is reached
 *   (JS Map preserves insertion order, so the first key is always the LRU).
 * - A `setInterval` sweep clears TTL-expired entries every 60 s so memory
 *   does not accumulate across long-running processes.  The timer is unref'd
 *   so it does not prevent the Node.js event loop from exiting.
 * - Call `close()` to cancel the sweep before shutdown.
 */
export class DedupeCache {
  /** Map<eventId, insertedAtMs> — insertion order = LRU order */
  private seen = new Map<string, number>();
  private ttlMs: number;
  private maxSize: number;
  private sweepTimer: ReturnType<typeof setInterval> | null = null;

  constructor(ttlMs = 10 * 60 * 1000, maxSize = 10_000) {
    this.ttlMs = ttlMs;
    this.maxSize = maxSize;
    this.sweepTimer = setInterval(() => this.evictExpired(Date.now()), 60_000);
    this.sweepTimer.unref();
  }

  /** Number of entries currently held in the cache. */
  get size(): number {
    return this.seen.size;
  }

  isDuplicate(eventId: string): boolean {
    const now = Date.now();
    if (this.seen.has(eventId)) {
      // Refresh recency: delete then re-insert moves the key to MRU position.
      this.seen.delete(eventId);
      this.seen.set(eventId, now);
      return true;
    }
    // Evict the LRU entry before inserting when at capacity.
    if (this.seen.size >= this.maxSize) {
      const lruKey = this.seen.keys().next().value;
      if (lruKey !== undefined) this.seen.delete(lruKey);
    }
    this.seen.set(eventId, now);
    return false;
  }

  close(): void {
    if (this.sweepTimer !== null) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
  }

  private evictExpired(now: number): void {
    for (const [id, ts] of this.seen) {
      if (now - ts > this.ttlMs) this.seen.delete(id);
    }
  }
}
