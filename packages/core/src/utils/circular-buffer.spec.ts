import { describe, expect, it } from 'vitest';

import { CircularBuffer } from './circular-buffer.js';

describe('CircularBuffer', () => {
  it('starts empty', () => {
    const buf = new CircularBuffer<number>(3);
    expect(buf.size).toBe(0);
  });

  it('returns undefined from push until full', () => {
    const buf = new CircularBuffer<number>(3);
    expect(buf.push(1)).toBeUndefined();
    expect(buf.push(2)).toBeUndefined();
    expect(buf.push(3)).toBeUndefined();
    expect(buf.size).toBe(3);
  });

  it('evicts the oldest value in FIFO order once full', () => {
    const buf = new CircularBuffer<number>(3);
    buf.push(1);
    buf.push(2);
    buf.push(3);
    expect(buf.push(4)).toBe(1);
    expect(buf.push(5)).toBe(2);
    expect(buf.push(6)).toBe(3);
  });

  it('keeps size pegged at capacity after overflow', () => {
    const buf = new CircularBuffer<number>(2);
    buf.push(1);
    buf.push(2);
    buf.push(3);
    buf.push(4);
    expect(buf.size).toBe(2);
  });

  it('supports capacity of 1 (each push evicts the previous)', () => {
    const buf = new CircularBuffer<string>(1);
    expect(buf.push('a')).toBeUndefined();
    expect(buf.push('b')).toBe('a');
    expect(buf.push('c')).toBe('b');
    expect(buf.size).toBe(1);
  });

  it('stores arbitrary types (booleans)', () => {
    const buf = new CircularBuffer<boolean>(2);
    buf.push(true);
    buf.push(false);
    expect(buf.push(true)).toBe(true);
    expect(buf.push(false)).toBe(false);
  });

  describe('clone', () => {
    it('produces an independent copy with the same contents', () => {
      const original = new CircularBuffer<number>(3);
      original.push(1);
      original.push(2);

      const copy = original.clone();
      expect(copy.size).toBe(2);

      // Mutating the copy must not affect the original
      copy.push(3);
      copy.push(4);
      expect(copy.push(5)).toBe(2); // eviction order continues from the original head
      expect(original.size).toBe(2);
    });

    it('preserves the head position so eviction order continues correctly', () => {
      const original = new CircularBuffer<number>(3);
      original.push(1);
      original.push(2);
      original.push(3);
      original.push(4); // evicts 1, head now at index 1

      const copy = original.clone();
      // Next push on both should evict 2
      expect(original.push(5)).toBe(2);
      expect(copy.push(5)).toBe(2);
    });
  });

  describe('toSnapshot / fromSnapshot', () => {
    it('round-trips an empty buffer', () => {
      const a = new CircularBuffer<number>(3);
      const b = CircularBuffer.fromSnapshot<number>(a.toSnapshot());

      expect(b.size).toBe(0);
      // Behaves like a fresh buffer
      expect(b.push(1)).toBeUndefined();
      expect(b.push(2)).toBeUndefined();
      expect(b.push(3)).toBeUndefined();
      expect(b.push(4)).toBe(1);
    });

    it('round-trips a partial buffer (no wrap yet)', () => {
      const a = new CircularBuffer<number>(5);
      a.push(10);
      a.push(20);

      const b = CircularBuffer.fromSnapshot<number>(a.toSnapshot());
      expect(b.size).toBe(2);
      // The next 3 pushes fill remaining slots; the 6th push evicts the oldest (10).
      expect(b.push(30)).toBeUndefined();
      expect(b.push(40)).toBeUndefined();
      expect(b.push(50)).toBeUndefined();
      expect(b.push(60)).toBe(10);
    });

    it('round-trips a full buffer at head=0 (just wrapped)', () => {
      const a = new CircularBuffer<number>(3);
      a.push(1);
      a.push(2);
      a.push(3); // size=3, head wrapped back to 0

      const b = CircularBuffer.fromSnapshot<number>(a.toSnapshot());
      expect(b.push(4)).toBe(1); // oldest
      expect(b.push(5)).toBe(2);
      expect(b.push(6)).toBe(3);
    });

    it('round-trips a full buffer with head mid-array', () => {
      const a = new CircularBuffer<number>(3);
      a.push(1);
      a.push(2);
      a.push(3);
      a.push(4); // evicts 1, head=1
      a.push(5); // evicts 2, head=2
      // Internal layout: buffer=[4,5,3], head=2, size=3; next eviction is 3.

      const b = CircularBuffer.fromSnapshot<number>(a.toSnapshot());
      expect(b.push(6)).toBe(3);
      expect(b.push(7)).toBe(4);
      expect(b.push(8)).toBe(5);
    });
  });
});
