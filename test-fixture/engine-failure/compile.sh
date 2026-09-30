#!/bin/sh
# Usage: compile.sh <state dir> <inputPath> <outputPath>
#
# Ignores the source. The first compile (genesis) gets candidate-diff.o; every later one gets
# candidate-odd-size.o, which makes objdiff panic until, a few thousand panics in, the engine dies.
set -e
FIXTURE_DIR="$(cd "$(dirname "$0")" && pwd)"
if [ -f "$1/genesis-done" ]; then
  cp "$FIXTURE_DIR/candidate-odd-size.o" "$3"
else
  touch "$1/genesis-done"
  cp "$FIXTURE_DIR/candidate-diff.o" "$3"
fi
