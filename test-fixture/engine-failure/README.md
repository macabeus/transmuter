# engine-failure

Fixture for the "stops the search when the scoring engine fails" test in
`packages/core/src/search/mutation-search.spec.ts`. The objects are copied from
@matchkit/scoring's edge fixtures.

## Files

- `target.o`, `candidate-diff.o` — agbcc, `int add_one(int x) { return x + 1; }` vs `x + 2`
- `candidate-odd-size.o` — `candidate-diff.o` with `add_one`'s `st_size` cut to 3, so its last row is
  half an instruction and objdiff panics displaying it
- `compile.sh` — fake compiler that serves these objects
