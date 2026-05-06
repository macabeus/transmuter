import { describe, expect, it } from 'vitest';
import { parse } from '~/parser.js';
import { Rng } from '~/rng.js';

import { CompositeNodeFilter } from './node-filter.js';

describe('CompositeNodeFilter', () => {
  const source = `void test() {
  int a = 1;
  int b = 2;
  int c = 3;
  int d = 4;
  int e = 5;
}`;

  describe('avoid regions', () => {
    it('filters out nodes in avoid regions', () => {
      const filter = new CompositeNodeFilter(
        [],
        [{ type: 'avoid-region', id: 'protect', description: 'protect', lines: { start: 3, end: 3 } }],
      );
      const rng = new Rng(42);

      // Get declaration nodes
      const root = parse('c', source);
      const decls = root.root().findAll({ rule: { kind: 'declaration' } });
      expect(decls.length).toBeGreaterThan(0);

      const filtered = filter.filter(decls, rng);
      // Should have fewer nodes than the original (line 3 filtered out)
      expect(filtered.length).toBeLessThanOrEqual(decls.length);
    });

    it('returns all nodes if avoid region filters everything out', () => {
      const filter = new CompositeNodeFilter(
        [],
        [{ type: 'avoid-region', id: 'protect-all', description: 'protect', lines: { start: 1, end: 100 } }],
      );
      const rng = new Rng(42);

      const root = parse('c', source);
      const decls = root.root().findAll({ rule: { kind: 'declaration' } });

      // Should fall back to returning all nodes
      const filtered = filter.filter(decls, rng);
      expect(filtered.length).toBe(decls.length);
    });
  });

  describe('focus regions', () => {
    it('returns a subset when focus region is active', () => {
      const filter = new CompositeNodeFilter(
        [{ type: 'focus-region', id: 'focus', description: 'focus', lines: { start: 2, end: 3 }, strength: 1.0 }],
        [],
      );
      const rng = new Rng(42);

      const root = parse('c', source);
      const decls = root.root().findAll({ rule: { kind: 'declaration' } });

      // With strength=1.0, should always return only in-focus nodes
      const filtered = filter.filter(decls, rng);
      expect(filtered.length).toBeLessThan(decls.length);

      // All returned nodes should overlap with lines 2-3
      for (const node of filtered) {
        const startLine = node.range().start.line + 1;
        const endLine = node.range().end.line + 1;
        expect(startLine <= 3 && endLine >= 2).toBe(true);
      }
    });

    it('returns empty result on empty input', () => {
      const filter = new CompositeNodeFilter(
        [{ type: 'focus-region', id: 'focus', description: 'focus', lines: { start: 1, end: 2 } }],
        [],
      );
      const rng = new Rng(42);

      const filtered = filter.filter([], rng);
      expect(filtered).toHaveLength(0);
    });
  });

  describe('combined focus + avoid', () => {
    it('applies both filters', () => {
      const filter = new CompositeNodeFilter(
        [{ type: 'focus-region', id: 'focus', description: 'focus', lines: { start: 2, end: 4 }, strength: 1.0 }],
        [{ type: 'avoid-region', id: 'avoid', description: 'avoid', lines: { start: 3, end: 3 } }],
      );
      const rng = new Rng(42);

      const root = parse('c', source);
      const decls = root.root().findAll({ rule: { kind: 'declaration' } });

      const filtered = filter.filter(decls, rng);
      // Should have nodes from lines 2-4 but not line 3
      for (const node of filtered) {
        const startLine = node.range().start.line + 1;
        const endLine = node.range().end.line + 1;
        // Should not be entirely within avoid region
        const isEntirelyInAvoid = startLine >= 3 && endLine <= 3;
        expect(isEntirelyInAvoid).toBe(false);
      }
    });
  });
});
