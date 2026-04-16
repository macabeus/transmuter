/**
 * Source hash deduplicator.
 *
 * Tracks Wyhash digests of mutation outputs to avoid reprocessing duplicates.
 * Uses an LRU-style eviction when the cap is reached.
 *
 * Scope: one instance per `MutationSearch` session, shared across all slots in
 * that session's `SlotOrchestrator`. This is intentional: sessions have
 * distinct filters, focus regions, score transforms, and rule weights, so a
 * source rejected (or scored badly) in one session may be valid in another.
 * Sharing dedup state across sessions would silently skip valid candidates.
 */

/** Default maximum number of hashes to track. */
const DEFAULT_MAX_SIZE = 200_000;

export class Deduplicator {
  #seen: Set<string>;
  #order: string[];
  #maxSize: number;

  constructor(maxSize: number = DEFAULT_MAX_SIZE) {
    this.#seen = new Set();
    this.#order = [];
    this.#maxSize = maxSize;
  }

  /** Compute a non-cryptographic content hash of source code. */
  static hash(source: string): string {
    return Bun.hash(source).toString(36);
  }

  /** Mark a hash as seen. Evicts oldest entry if at capacity. */
  add(hash: string): void {
    if (this.#seen.has(hash)) {
      return;
    }

    if (this.#seen.size >= this.#maxSize) {
      // Evict the oldest entry
      const oldest = this.#order.shift();
      if (oldest) {
        this.#seen.delete(oldest);
      }
    }

    this.#seen.add(hash);
    this.#order.push(hash);
  }

  /**
   * Check and add in one call. Returns true if the hash was already seen
   * (i.e., this is a duplicate and should be skipped).
   */
  checkAndAdd(source: string): boolean {
    const hash = Deduplicator.hash(source);
    if (this.#seen.has(hash)) {
      return true;
    }
    this.add(hash);
    return false;
  }

  /** Number of tracked hashes. */
  get size(): number {
    return this.#seen.size;
  }

  /** Reset the deduplicator. */
  clear(): void {
    this.#seen.clear();
    this.#order.length = 0;
  }
}
