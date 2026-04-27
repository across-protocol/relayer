#!/bin/sh
# Ratchet down strictNullChecks errors.
#
#   strict-null-budget.sh                 enforce: fails on regression AND
#                                         on improvement (prompts manual update).
#   strict-null-budget.sh --auto-ratchet  on improvement, rewrite the budget
#                                         file and `git add` it so the current
#                                         commit picks up the reduction.
#
# Uses `tsc --incremental` with a dedicated buildinfo file so warm runs are
# fast. The error list is cached in $ERRORS_FILE; tsc is skipped if no input
# is newer than the cache. When the budget reaches 0, flip
# `strictNullChecks: true` in tsconfig.json and delete this script.

set -eu

MODE="${1:-enforce}"
BUDGET_FILE=".strict-null-budget"
BUILDINFO=".tsbuildinfo-strict"
ERRORS_FILE=".strict-null-errors"
INPUTS="src scripts index.ts hardhat.config.ts tsconfig.json package.json yarn.lock"

[ -f "$BUDGET_FILE" ] || { echo "missing $BUDGET_FILE"; exit 2; }
BUDGET=$(cat "$BUDGET_FILE")

# Skip tsc if every input is older than the cached error list.
if [ -f "$ERRORS_FILE" ] && \
   [ -z "$(find $INPUTS "$0" -newer "$ERRORS_FILE" -type f 2>/dev/null | head -1)" ]; then
  : # cache hit
else
  yarn -s tsc --noEmit --strictNullChecks --incremental --tsBuildInfoFile "$BUILDINFO" 2>&1 \
    | grep -E "^(src|scripts|index\.ts).*error TS" > "$ERRORS_FILE" || true
fi
ACTUAL=$(wc -l < "$ERRORS_FILE" | tr -d ' ')

if [ "$ACTUAL" -gt "$BUDGET" ]; then
  echo "strictNullChecks regressed: $ACTUAL > $BUDGET (baseline in $BUDGET_FILE)"
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

if [ "$ACTUAL" -lt "$BUDGET" ]; then
  DELTA=$((BUDGET - ACTUAL))
  if [ "$MODE" = "--auto-ratchet" ]; then
    echo "$ACTUAL" > "$BUDGET_FILE"
    git add "$BUDGET_FILE"
    echo "Nice — strictNullChecks down by $DELTA: $BUDGET -> $ACTUAL. Budget file updated and staged."
    exit 0
  fi
  echo "Nice — strictNullChecks down by $DELTA: $BUDGET -> $ACTUAL."
  echo "Update $BUDGET_FILE to $ACTUAL in this commit to ratchet the budget (or rerun with --auto-ratchet)."
  exit 1
fi

echo "strictNullChecks at budget: $ACTUAL"
