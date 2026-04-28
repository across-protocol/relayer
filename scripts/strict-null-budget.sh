#!/bin/sh
# Ratchet down strictNullChecks errors.
#
#   strict-null-budget.sh                 enforce: fail on regression AND on
#                                         unratcheted improvement.
#   strict-null-budget.sh --auto-ratchet  on improvement, restage the error
#                                         list (used by `yarn update-strict`).
#   strict-null-budget.sh --no-cache      bypass the freshness shortcut and
#                                         always run tsc (used in CI).
#
# Uses `tsc --incremental` with a dedicated buildinfo file so warm runs are
# fast. The error list is cached in $ERRORS_FILE; tsc is skipped if no input
# is newer than the cache. The committed copy of $ERRORS_FILE is the baseline:
# its line count is the previous budget. When the file is empty, flip
# `strictNullChecks: true` in tsconfig.json and delete this script.

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
INPUTS="src scripts index.ts hardhat.config.ts tsconfig.json package.json yarn.lock"

# Skip tsc if every input is older than the cached error list.
if [ -z "$NO_CACHE" ] && [ -f "$ERRORS_FILE" ] && \
   [ -z "$(find $INPUTS "$0" -newer "$ERRORS_FILE" -type f 2>/dev/null | head -1)" ]; then
  : # cache hit
else
  yarn -s tsc --noEmit --strictNullChecks --incremental --tsBuildInfoFile "$BUILDINFO" 2>&1 \
    | grep -E "^(src|scripts|index\.ts).*error TS" > "$ERRORS_FILE" || true
fi
ACTUAL=$(wc -l < "$ERRORS_FILE" | tr -d ' ')

if git cat-file -e HEAD:"$ERRORS_FILE" 2>/dev/null; then
  PREVIOUS=$(git show HEAD:"$ERRORS_FILE" | wc -l | tr -d ' ')
else
  PREVIOUS=$ACTUAL # bootstrap: no baseline yet
fi

if [ "$ACTUAL" -gt "$PREVIOUS" ]; then
  echo "strictNullChecks regressed: $ACTUAL > $PREVIOUS"
  CHANGED=$( { git diff --name-only origin/master... 2>/dev/null; git diff --name-only; git diff --cached --name-only; } | sort -u | grep -E '\.(ts|tsx)$' || true)
  if [ -n "$CHANGED" ]; then
    SUSPECTS=$(printf '%s\n' "$CHANGED" | grep -F -f - "$ERRORS_FILE" || true)
    if [ -n "$SUSPECTS" ]; then
      echo
      echo "Likely culprits (errors in files touched on this branch):"
      printf '%s\n' "$SUSPECTS"
    fi
  fi
  exit 1
fi

if [ "$ACTUAL" -lt "$PREVIOUS" ]; then
  DELTA=$((PREVIOUS - ACTUAL))
  if [ "$MODE" = "auto-ratchet" ]; then
    git add "$ERRORS_FILE"
    echo "Nice — strictNullChecks down by $DELTA: $PREVIOUS -> $ACTUAL. Error list updated and staged."
    exit 0
  fi
  echo "Nice — strictNullChecks down by $DELTA: $PREVIOUS -> $ACTUAL."
  echo "Stage $ERRORS_FILE in this commit to ratchet the budget (or run \`yarn update-strict\`)."
  exit 1
fi

echo "strictNullChecks at budget: $ACTUAL"
