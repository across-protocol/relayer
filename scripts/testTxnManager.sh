#!/bin/sh
# Helper for running TransactionManager broker tests.
# Run each subcommand in its own terminal.
#
# Usage:
#   scripts/testTxnManager.sh manager          # start the TransactionManager
#   scripts/testTxnManager.sh parallel [N]     # fire N parallel submits (default 5)
#   scripts/testTxnManager.sh multi [W] [C]    # spawn W concurrent caller processes,
#                                              # each firing C parallel submits (default 3 3)
#   scripts/testTxnManager.sh single           # one submit + await receipt
#   scripts/testTxnManager.sh inspect          # tail request/response Pub/Sub traffic
#   scripts/testTxnManager.sh handover         # start manager A, then B; observe A's
#                                              # renewal detect displacement and drain
#   scripts/testTxnManager.sh handover-load [N] # same, but with N parallel submits
#                                              # running across the handover (default 10)
#
# Override defaults via env if needed:
#   CHAIN_ID, TOKEN, RECIPIENT, WALLET

set -e

CHAIN_ID="${CHAIN_ID:-11155111}"
TOKEN="${TOKEN:-0x49fCaC04AE71dbD074304Fb12071bD771e0E927A}"
RECIPIENT="${RECIPIENT:-0x9A8f92a830A5cB89a3816e3D267CB7791c16b04D}"
WALLET="${WALLET:-secret}"

cmd="${1:-}"

case "$cmd" in
  manager)
    TXN_MANAGER_CHAIN_ID="$CHAIN_ID" \
      yarn ts-node ./index.ts --transactionManager --wallet="$WALLET"
    ;;
  parallel)
    count="${2:-5}"
    TRANSACTION_CLIENT_BROADCAST=redis \
      yarn ts-node ./scripts/testTxnManagerParallel.ts \
        --chainId "$CHAIN_ID" \
        --token "$TOKEN" \
        --to "$RECIPIENT" \
        --count "$count" \
        --wallet="$WALLET"
    ;;
  multi)
    workers="${2:-3}"
    count="${3:-3}"
    echo "Spawning $workers concurrent callers, each firing $count submits ($((workers * count)) total)" >&2
    start=$(date +%s)
    i=1
    while [ "$i" -le "$workers" ]; do
      (
        TRANSACTION_CLIENT_BROADCAST=redis \
          yarn ts-node ./scripts/testTxnManagerParallel.ts \
            --chainId "$CHAIN_ID" \
            --token "$TOKEN" \
            --to "$RECIPIENT" \
            --count "$count" \
            --wallet="$WALLET" 2>&1 | sed "s/^/[w$i] /"
      ) &
      i=$((i + 1))
    done
    wait
    echo "All $workers workers settled in $(( $(date +%s) - start ))s" >&2
    ;;
  single)
    TRANSACTION_CLIENT_BROADCAST=redis \
      yarn ts-node ./scripts/testTxnManagerErc20.ts \
        --chainId "$CHAIN_ID" \
        --token "$TOKEN" \
        --amount 0 \
        --to "$RECIPIENT" \
        --wait \
        --wallet="$WALLET"
    ;;
  inspect)
    yarn ts-node ./scripts/inspectTxnPubsub.ts --chain "$CHAIN_ID"
    ;;
  handover)
    # Demonstrate the InstanceCoordinator-driven handover: A claims the lease,
    # B starts later and overwrites it, A's next renewal observes the change
    # and aborts (drain + exit). Bounded by leaseRenewIntervalSec (~20s).
    echo "Starting manager A in background..."
    TXN_MANAGER_CHAIN_ID="$CHAIN_ID" \
      yarn ts-node ./index.ts --transactionManager --wallet="$WALLET" 2>&1 | sed "s/^/[A] /" &
    a_pid=$!

    sleep 5

    echo "Starting manager B in background; A should detect and drain within ~20s..."
    TXN_MANAGER_CHAIN_ID="$CHAIN_ID" \
      yarn ts-node ./index.ts --transactionManager --wallet="$WALLET" 2>&1 | sed "s/^/[B] /" &
    b_pid=$!

    # A is expected to exit on its own when displaced. Wait for it with a cap.
    echo "Waiting up to 60s for A to exit..."
    waited=0
    while kill -0 "$a_pid" 2>/dev/null && [ "$waited" -lt 60 ]; do
      sleep 1
      waited=$((waited + 1))
    done
    if kill -0 "$a_pid" 2>/dev/null; then
      echo "A did not exit within 60s; killing." >&2
      kill "$a_pid" 2>/dev/null
      wait "$a_pid" 2>/dev/null
      echo "Handover did NOT complete as expected." >&2
      kill "$b_pid" 2>/dev/null
      wait "$b_pid" 2>/dev/null
      exit 1
    fi
    echo "A exited after ${waited}s. Stopping B." >&2
    kill "$b_pid" 2>/dev/null
    wait "$b_pid" 2>/dev/null
    ;;
  handover-load)
    # Handover while a caller is submitting concurrently. Sequence:
    #   t=0:  start manager A; A claims lease.
    #   t=5:  start parallel caller (N submits).
    #   t=7:  start manager B; B overwrites the lease.
    #   A's renewal task detects displacement within ~20s and drains.
    #   Caller may see brief overlap (both A and B receiving requests) —
    #   TransactionClient's REPLACEMENT_UNDERPRICED retry resolves nonce races.
    count="${2:-10}"

    echo "Starting manager A..."
    TXN_MANAGER_CHAIN_ID="$CHAIN_ID" \
      yarn ts-node ./index.ts --transactionManager --wallet="$WALLET" 2>&1 | sed "s/^/[A] /" &
    a_pid=$!
    sleep 5

    echo "Starting parallel caller ($count submits)..."
    TRANSACTION_CLIENT_BROADCAST=redis \
      yarn ts-node ./scripts/testTxnManagerParallel.ts \
        --chainId "$CHAIN_ID" \
        --token "$TOKEN" \
        --to "$RECIPIENT" \
        --count "$count" \
        --wallet="$WALLET" 2>&1 | sed "s/^/[caller] /" &
    caller_pid=$!
    sleep 2

    echo "Starting manager B (handover trigger)..."
    TXN_MANAGER_CHAIN_ID="$CHAIN_ID" \
      yarn ts-node ./index.ts --transactionManager --wallet="$WALLET" 2>&1 | sed "s/^/[B] /" &
    b_pid=$!

    echo "Waiting up to 90s for A to exit..."
    waited=0
    while kill -0 "$a_pid" 2>/dev/null && [ "$waited" -lt 90 ]; do
      sleep 1
      waited=$((waited + 1))
    done
    if kill -0 "$a_pid" 2>/dev/null; then
      echo "A did not exit within 90s; killing." >&2
      kill "$a_pid" 2>/dev/null
      wait "$a_pid" 2>/dev/null
    else
      echo "A exited after ${waited}s." >&2
    fi

    echo "Waiting up to 90s for caller to settle..."
    caller_waited=0
    while kill -0 "$caller_pid" 2>/dev/null && [ "$caller_waited" -lt 90 ]; do
      sleep 1
      caller_waited=$((caller_waited + 1))
    done
    if kill -0 "$caller_pid" 2>/dev/null; then
      echo "Caller did not settle within 90s; killing." >&2
      kill "$caller_pid" 2>/dev/null
      wait "$caller_pid" 2>/dev/null
      caller_exit=124
    else
      wait "$caller_pid"
      caller_exit=$?
      echo "Caller exited after ${caller_waited}s (status=$caller_exit)." >&2
    fi
    echo "Stopping B." >&2
    # Kill the pipeline's sed AND the underlying manager process. $b_pid is sed
    # in a piped background job; the yarn/ts-node process keeps running unless
    # signalled directly. Match by chain + flag to avoid touching other bots.
    kill "$b_pid" 2>/dev/null
    pkill -TERM -f "ts-node ./index.ts --transactionManager" 2>/dev/null || true
    wait "$b_pid" 2>/dev/null
    exit "$caller_exit"
    ;;
  *)
    echo "Usage: $0 {manager|parallel [N]|multi [W] [C]|single|inspect|handover|handover-load [N]}" >&2
    exit 2
    ;;
esac
