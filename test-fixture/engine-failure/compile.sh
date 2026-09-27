#!/bin/sh
# Usage: compile.sh <state dir> <inputPath> <outputPath>
#
# Ignores the source. The first compile (the search's genesis) gets candidate-diff.o, which scores;
# every later one gets candidate-odd-size.o, whose last row the objdiff engine panics on. A few
# thousand panics later the engine is dead, which is what engine-failure tests need.
set -e
FIXTURE_DIR="$(cd "$(dirname "$0")" && pwd)"
if [ -f "$1/genesis-done" ]; then
  cp "$FIXTURE_DIR/candidate-odd-size.o" "$3"
else
  touch "$1/genesis-done"
  cp "$FIXTURE_DIR/candidate-diff.o" "$3"
fi
