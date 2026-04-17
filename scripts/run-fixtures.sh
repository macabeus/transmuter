#!/usr/bin/env bash
set -e

# Run test fixtures.
#
# Usage:
#   ./scripts/run-fixtures.sh                        # run all fixtures
#   ./scripts/run-fixtures.sh --fade-out-controller   # run a single fixture
#   ./scripts/run-fixtures.sh --cpp-cast-cleanup      # run a single fixture

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
FIXTURE_DIR="$REPO_DIR/test-fixture"

# Fixture name -> runner script path (relative to test-fixture/)
FIXTURE_NAMES="fade-out-controller entity-item-drop fixed-mul8 cpp-method-order cpp-cast-cleanup pascal-power-check pascal-cast-cleanup"

get_script() {
  case "$1" in
    fade-out-controller) echo "fade-out-controller/run-permute.ts" ;;
    entity-item-drop)    echo "entity-item-drop/run-multi-branch.ts" ;;
    fixed-mul8)          echo "fixed-mul8/run-refine.ts" ;;
    cpp-method-order)    echo "cpp-method-order/run-permute.ts" ;;
    cpp-cast-cleanup)    echo "cpp-cast-cleanup/run-refine.ts" ;;
    pascal-power-check)  echo "pascal-power-check/run-permute.ts" ;;
    pascal-cast-cleanup) echo "pascal-cast-cleanup/run-refine.ts" ;;
    *) return 1 ;;
  esac
}

run_fixture() {
  local name="$1"
  local script
  script=$(get_script "$name") || {
    echo "Unknown fixture: $name"
    echo "Available: $FIXTURE_NAMES"
    exit 1
  }

  local full_path="$FIXTURE_DIR/$script"
  if [ ! -f "$full_path" ]; then
    echo "Fixture script not found: $full_path"
    exit 1
  fi

  echo ""
  echo "━━━ $name ━━━"
  echo ""
  bun run "$full_path"
}

# Skip leading "--" if present (pnpm passes it when using `pnpm run test:fixture -- --name`)
if [ "$1" = "--" ]; then
  shift
fi

if [ $# -eq 0 ]; then
  FAILED=0
  for name in $FIXTURE_NAMES; do
    if ! run_fixture "$name"; then
      FAILED=$((FAILED + 1))
    fi
  done
  echo ""
  if [ $FAILED -gt 0 ]; then
    echo "━━━ $FAILED fixture(s) failed ━━━"
    exit 1
  else
    echo "━━━ All fixtures passed ━━━"
  fi
else
  # Strip leading --
  NAME="${1#--}"
  run_fixture "$NAME"
fi
