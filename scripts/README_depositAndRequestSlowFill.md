# Deposit + Request Slow Fill Script

## Overview

`depositAndRequestSlowFill.ts` is an operator tool for winding down LP support for a token. For each requested
token it:

1. Resolves every chain with an active HubPool pool rebalance route for the token (excluding disabled and lite
   chains, per the ConfigStore `DISABLED_CHAINS` / `LITE_CHAIN_ID_INDICES` global configs).
2. Submits a deposit on the HubPool chain SpokePool to each destination chain, with
   `outputAmount == inputAmount` (0 relayer fee, so a fast fill is unprofitable and the deposit remains unfilled),
   no exclusivity and an empty message.
3. Submits a corresponding `requestSlowFill()` on each destination chain SpokePool, reconstructing the relay data
   from the emitted `FundsDeposited` event.

The resulting deposit + slow fill request events force the next root bundle to emit a pool rebalance leaf for
every (chain, token) pair, so that zeroed `spokeTargetBalances` take effect and all SpokePool balances are
returned to the HubPool.

## Sequencing

This script is one step in a multi-transaction wind-down:

1. Execute the ConfigStore `updateTokenConfig()` transaction that zeroes the token's rate model and
   `spokeTargetBalances`. The script warns (and prompts) if this does not appear to have happened yet.
2. **Run this script** to submit deposits + slow fill requests for all affected tokens.
3. Wait for the subsequent root bundle (containing the pool rebalance leaves that pull tokens back to the hub)
   to be proposed **and executed**.
4. Only then execute the HubPool `setPoolRebalanceRoute()` transaction that removes the token's routes. Removing
   routes earlier would prevent the bundle from creating the required leaves.

## Prerequisites

- RPC providers configured in `.env` (same convention as the main relayer configuration), for the hub chain and
  every destination chain with an active route.
- A funded wallet: the per-route deposit amount of each token on the hub chain, plus gas on the hub chain and
  every destination chain (note: Lens gas is GHO). The dry run reports both.

## Usage

Dry run (default) — discovers routes and prints the plan, balances and warnings without sending anything:

```bash
yarn tsx ./scripts/depositAndRequestSlowFill --wallet privateKey
```

Execute (prompts for confirmation before each route):

```bash
yarn tsx ./scripts/depositAndRequestSlowFill --wallet privateKey --execute
```

Options:

| Option        | Default        | Description                                                 |
| ------------- | -------------- | ----------------------------------------------------------- |
| `--tokens`    | `ACX,WGHO,UMA` | Comma-separated token symbols (hub chain symbols).          |
| `--amount`    | `1`            | Deposit amount per route, in whole tokens.                  |
| `--chainIds`  | (all routes)   | Restrict to a comma-separated list of destination chains.   |
| `--recipient` | depositor      | Recipient of the slow fill on the destination chain.        |
| `--execute`   | off            | Submit transactions; without it the script is a dry run.    |
| `--wallet`    | `secret`       | Wallet type (`mnemonic`, `privateKey`, `gckms`).            |

Note: the deposited tokens are paid out (less any LP fee — 0 once the rate model is zeroed) to the recipient on
each destination chain when the slow fill leaf executes, i.e. the depositor is made whole on the destination
chain.

If a deposit is fast-filled before the slow fill request lands (unexpected, as the relayer fee is 0), the script
reports it and marks the route as failed: an outright fill does not move the destination chain running balance,
so that route should be re-run or investigated.
