#!/bin/sh
# Ratchet down strictNullChecks errors.
#
#   strict-null-budget.sh                 enforce: fail on regression AND on
#                                         unratcheted improvement.
#   strict-null-budget.sh --auto-ratchet  on improvement, update the budget
#                                         (used by `yarn update-strict`).
#   strict-null-budget.sh --no-cache      bypass the freshness shortcut and
#                                         always run tsc (used in CI).
#
# Uses `tsc --incremental` with a dedicated buildinfo file so warm runs are
# fast. The full violation list is regenerated into $ERRORS_FILE (gitignored)
# for local inspection. The committed budget is a single integer in
# $BUDGET_FILE; when it reaches 0, flip `strictNullChecks: true` in
# tsconfig.json and delete this script.

set -eu

MODE=enforce
NO_CACHE=
for arg in "$@"; do
  case "$arg" in
    --auto-ratchet) MODE=auto-ratchet ;;
    --no-cache) NO_CACHE=1 ;;
    *) echo "unknown arg: $arg" >&2; exit 2 ;;
  esac
done

BUILDINFO=".tsbuildinfo-strict"
ERRORS_FILE=".strict-null-errors"
BUDGET_FILE=".strict-null-budget"
INPUTS="src scripts index.ts hardhat.config.ts tsconfig.json package.json yarn.lock"

# Skip tsc if every input is older than the cached error list.
if [ -z "$NO_CACHE" ] && [ -f "$ERRORS_FILE" ] && \
   [ -z "$(find $INPUTS "$0" -newer "$ERRORS_FILE" -type f 2>/dev/null | head -1)" ]; then
  : # cache hit
else
  # Strip the worktree's absolute path so the cache is identical across developers.
  # `--noErrorTruncation` keeps tsc from cutting messages mid-path, so the sed below
  # can normalize every occurrence rather than leaving truncated stubs behind.
  REPO_ROOT=$(pwd)
  yarn -s tsc --noEmit --strictNullChecks --noErrorTruncation --incremental --tsBuildInfoFile "$BUILDINFO" 2>&1 \
    | grep -E "^(src|scripts|index\.ts).*error TS" \
    | sed "s#${REPO_ROOT}/##g" > "$ERRORS_FILE" || true
fi
ACTUAL=$(wc -l < "$ERRORS_FILE" | tr -d ' ')

if [ ! -f "$BUDGET_FILE" ]; then
  echo "Missing $BUDGET_FILE" >&2
  exit 2
fi
BUDGET=$(tr -d ' \n' < "$BUDGET_FILE")

if [ "$ACTUAL" -gt "$BUDGET" ]; then
  echo "strictNullChecks regressed: $ACTUAL > $BUDGET"
  echo
  echo "Current violations:"
  cat "$ERRORS_FILE"
  echo
  echo "Reproduce locally: yarn strict-null-budget --no-cache"
  exit 1
fi

if [ "$ACTUAL" -lt "$BUDGET" ]; then
  DELTA=$((BUDGET - ACTUAL))
  if [ "$MODE" = "auto-ratchet" ]; then
    printf '%s\n' "$ACTUAL" > "$BUDGET_FILE"
    git add "$BUDGET_FILE"
    echo "Nice — strictNullChecks down by $DELTA: $BUDGET -> $ACTUAL. Budget updated and staged."
    exit 0
  fi
  echo "Nice — strictNullChecks down by $DELTA: $BUDGET -> $ACTUAL."
  echo
  echo "Run \`yarn update-strict\` and stage $BUDGET_FILE before pushing."
  exit 1
fi

echo "strictNullChecks at budget: $ACTUAL"
