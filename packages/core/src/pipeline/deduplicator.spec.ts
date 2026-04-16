import { describe, expect, it } from 'vitest';

import { Deduplicator } from './deduplicator.js';

describe('Deduplicator', () => {
  it('detects duplicate sources', () => {
    const dedup = new Deduplicator();
    expect(dedup.checkAndAdd('int main() {}')).toBe(false); // first time
    expect(dedup.checkAndAdd('int main() {}')).toBe(true); // duplicate
    expect(dedup.checkAndAdd('int foo() {}')).toBe(false); // different
  });

  it('tracks size correctly', () => {
    const dedup = new Deduplicator();
    dedup.checkAndAdd('a');
    dedup.checkAndAdd('b');
    dedup.checkAndAdd('a'); // duplicate, shouldn't increase size
    expect(dedup.size).toBe(2);
  });

  it('evicts oldest entries when at capacity', () => {
    const dedup = new Deduplicator(3);
    dedup.checkAndAdd('a');
    dedup.checkAndAdd('b');
    dedup.checkAndAdd('c');
    expect(dedup.size).toBe(3);

    // Adding a 4th should evict 'a'
    dedup.checkAndAdd('d');
    expect(dedup.size).toBe(3);

    // 'a' should no longer be tracked
    expect(dedup.checkAndAdd('a')).toBe(false);
  });

  it('clear() resets everything', () => {
    const dedup = new Deduplicator();
    dedup.checkAndAdd('x');
    dedup.clear();
    expect(dedup.size).toBe(0);
    expect(dedup.checkAndAdd('x')).toBe(false);
  });

  it('hash() is deterministic and distinguishes distinct inputs', () => {
    const h1 = Deduplicator.hash('hello world');
    const h2 = Deduplicator.hash('hello world');
    const h3 = Deduplicator.hash('hello worlq');
    expect(h1).toBe(h2);
    expect(h1).not.toBe(h3);
    expect(h1.length).toBeGreaterThan(0);
  });
});
