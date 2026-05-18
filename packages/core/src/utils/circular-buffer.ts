/**
 * Generic fixed-capacity ring buffer with FIFO eviction.
 *
 * `push` returns the evicted value once the buffer is full, otherwise `undefined`.
 * Callers that store a type which can legitimately contain `undefined` should
 * track fullness via `size` instead of relying on the return value.
 */
export class CircularBuffer<T> {
  #buffer: T[];
  #head = 0;
  #size = 0;

  constructor(capacity: number) {
    this.#buffer = new Array<T>(capacity);
  }

  get size(): number {
    return this.#size;
  }

  /**
   * Push a value onto the buffer.
   * Returns the evicted value if the buffer was full, otherwise undefined.
   */
  push(value: T): T | undefined {
    const evicted = this.#size === this.#buffer.length ? this.#buffer[this.#head] : undefined;
    this.#buffer[this.#head] = value;
    this.#head = (this.#head + 1) % this.#buffer.length;
    if (this.#size < this.#buffer.length) {
      this.#size++;
    }
    return evicted;
  }

  clone(): CircularBuffer<T> {
    const copy = new CircularBuffer<T>(this.#buffer.length);
    copy.#buffer = [...this.#buffer];
    copy.#head = this.#head;
    copy.#size = this.#size;
    return copy;
  }

  /**
   * Snapshot the buffer's internal state for serialization.
   * Used by AdaptiveSelector.serialize() to ship Thompson stats to workers.
   */
  toSnapshot(): { capacity: number; head: number; size: number; values: T[] } {
    return {
      capacity: this.#buffer.length,
      head: this.#head,
      size: this.#size,
      // Slice up to `size` in raw buffer order (not insertion order — when the
      // buffer has wrapped, indices 0..size are physical positions, not chronological).
      // fromSnapshot copies values back to the same indices and re-pins head/size,
      // so eviction continues from the right slot. Slots beyond `size` are
      // uninitialised and excluded.
      values: this.#buffer.slice(0, this.#size),
    };
  }

  /**
   * Restore a buffer from a snapshot produced by toSnapshot().
   */
  static fromSnapshot<T>(snapshot: { capacity: number; head: number; size: number; values: T[] }): CircularBuffer<T> {
    const buf = new CircularBuffer<T>(snapshot.capacity);
    for (let i = 0; i < snapshot.values.length; i++) {
      buf.#buffer[i] = snapshot.values[i]!;
    }
    buf.#head = snapshot.head;
    buf.#size = snapshot.size;
    return buf;
  }
}
