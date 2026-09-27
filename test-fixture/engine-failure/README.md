# engine-failure

Objects for the test that a search stops when the scoring engine dies
(`packages/core/src/search/mutation-search.spec.ts`, "stops the search when the scoring engine fails").
They are @matchkit/scoring's edge fixtures:

- `target.o` and `candidate-diff.o`: agbcc, `int add_one(int x) { return x + 1; }` against `x + 2`.
- `candidate-odd-size.o`: `candidate-diff.o` with `add_one`'s `st_size` cut to 3, so its last row is
  half an instruction and the objdiff engine panics displaying it.
