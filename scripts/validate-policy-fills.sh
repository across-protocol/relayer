#!/usr/bin/env bash
# End-to-end validation of a ProfitClient policy from the RELAYER_POLICIES
# registry. For each route in the matrix, post a 0.5 USDT (or USDC) deposit on
# the origin SpokePool with `inputAmount == outputAmount` (true 1:1) and
# `exclusiveRelayer` pinned to the relayer being validated. Positive cases
# assert the relayer fills inside the exclusivity window; negative cases assert
# it does not.
#
# Required env:
#   RELAYER_ADDR              relayer hot wallet to pin as exclusiveRelayer
#   WALLET=mnemonic|privateKey|gckms|secret
#
# Optional env:
#   EXCLUSIVITY_SEC=60        exclusivity window in seconds
#   LOG_DIR=/tmp/policy-validate
#
# Required local state:
#   Test wallet funded with ~5 USDT and ~1 USDC per origin chain in the matrix.
#
# Usage:
#   RELAYER_ADDR=0x... WALLET=mnemonic bash scripts/validate-policy-fills.sh

set -eu

: "${RELAYER_ADDR:?set to the relayer hot wallet address}"
WALLET="${WALLET:-mnemonic}"
EXCL_SEC="${EXCLUSIVITY_SEC:-60}"
LOG_DIR="${LOG_DIR:-/tmp/policy-validate}"
mkdir -p "$LOG_DIR"

# 0.5 USDT or USDC, expressed in base units (6 decimals).
AMOUNT=500000

# Token addresses needed for the --outputToken override.
declare -A USDT_ADDR=(
  [1]=0xdAC17F958D2ee523a2206206994597C13D831ec7
  [10]=0x94b008aA00579c1307B0EF2c499aD98a8ce58e58
  [130]=0x9151434b16b9763660705744891fA906F660EcC5
  [137]=0xc2132D05D31c914a87C6611C10748AEb04B58e8F
  [143]=0xe7cd86e13AC4309349F30B3435a9d337750fC82D
  [4326]=0xB8CE59FC3717ada4C02eaDF9682A9e934F625ebb
  [8453]=0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2
  [9745]=0xB8CE59FC3717ada4C02eaDF9682A9e934F625ebb
  [42161]=0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9
)
declare -A USDC_ADDR=(
  [1]=0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48
  [999]=0xb88339CB7199b77E23DB6E890353E22632Ba630f
  [8453]=0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913
  [42161]=0xaf88d065e77c8cC2239327C5EDb3A432268e5831
)

# spec format: <expect:pass|fail>:<origin>:<dest>:<inputSymbol>:<outputSymbol>
# Adjust the matrix to match the policy under test.
declare -a MATRIX=(
  # ---- POSITIVE: policy matches (origin in policy allowlist, dest in policy) ----
  "pass:1:999:USDT:USDC"
  "pass:130:999:USDT:USDC"
  "pass:137:999:USDT:USDC"
  "pass:143:999:USDT:USDC"
  "pass:42161:999:USDT:USDC"

  # ---- NEGATIVE: origin outside the policy's allowlist ----
  "fail:4326:999:USDT:USDC"
  "fail:9745:999:USDT:USDC"

  # ---- NEGATIVE: destination outside the policy ----
  "fail:1:8453:USDT:USDC"
  "fail:137:8453:USDT:USDC"
  "fail:42161:8453:USDT:USDC"

  # ---- NEGATIVE: token pair not configured ----
  "fail:8453:1:USDC:USDT"
)

resolve_input_addr() {
  local sym=$1 chain=$2
  case "$sym" in
    USDT) echo "${USDT_ADDR[$chain]:-}";;
    USDC) echo "${USDC_ADDR[$chain]:-}";;
    *) echo "";;
  esac
}

pass=()
fail=()

run_one() {
  local expect=$1 origin=$2 dest=$3 src=$4 dst=$5
  local in_addr out_addr
  in_addr=$(resolve_input_addr "$src" "$origin")
  out_addr=$(resolve_input_addr "$dst" "$dest")
  if [ -z "$in_addr" ] || [ -z "$out_addr" ]; then
    fail+=("$src@$origin->$dst@$dest (missing token address)")
    return
  fi

  local log="$LOG_DIR/${origin}_${dest}_${src}_${dst}.log"
  set +e
  yarn tsx ./scripts/spokepool --wallet "$WALLET" deposit \
    --from "$origin" --to "$dest" --token "$src" --amount "$AMOUNT" --decimals \
    --outputToken "$out_addr" --outputAmount "$AMOUNT" \
    --exclusiveRelayer "$RELAYER_ADDR" \
    --exclusivityDeadline "$EXCL_SEC" \
    --noInteractive > "$log" 2>&1
  local rc=$?
  set -e

  local got
  if grep -q "Fill confirmed after" "$log"; then
    got=pass
  else
    got=fail
  fi
  printf "[expect=%s got=%s rc=%d] %s@%s -> %s@%s\n" "$expect" "$got" "$rc" "$src" "$origin" "$dst" "$dest"

  if [ "$got" = "$expect" ]; then
    pass+=("$src@$origin->$dst@$dest")
  else
    fail+=("$src@$origin->$dst@$dest (expected $expect, got $got, see $log)")
  fi
}

for spec in "${MATRIX[@]}"; do
  IFS=: read -r expect origin dest src dst <<< "$spec"
  run_one "$expect" "$origin" "$dest" "$src" "$dst"
done

echo
echo "==== RESULTS ===="
echo "PASS (${#pass[@]}):"
printf "  %s\n" "${pass[@]:-(none)}"
echo "FAIL (${#fail[@]}):"
printf "  %s\n" "${fail[@]:-(none)}"
[ ${#fail[@]} -eq 0 ]
