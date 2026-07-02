# Dataworker

## Bot description

The dataworker is responsible for proposing batches of relayer and depositor refunds for successfully filled and unfilled deposits respectively.

These batches of relayer refunds are summarized as Merkle roots and are also referred to as "root bundles" throughout the codebase ("root" coming from Merkle root and "bundle" referring to a set of Merkle roots comprising one batch of relayer refunds). To learn more about "root bundles" read the README.md.

Proposes these batches to the `HubPool` smart contract deployed on Ethereum and the batches are validated optimistically. Only one batch can be submitted at a time and any batch can be disputed, in which case the dispute is resolved by the UMA DVM system.

For more about the UMA system, go to /docs/uma.md.

## Constructing a valid batch or "root bundle" of repayments

Read /docs/bundle-construction.md for more details.

High level summary is that the Dataworker uses the SDK's `BundleDataClient` to construct a valid bundle and also compare a pending bundle to what it believes to be a "valid" root bundle.

## Runtime execution flow

The dataworker runtime file is index.ts. This file contains a `runDataworker()` function which constructs a new Dataworker instance and runs the following important logic in sequence:

1. Checks if there is an existing pending root bundle. If there is one, validate it. If invalid, submit a dispute, otherwise proceed.
2. If no existing pending root bundle, construct and propose a new one.
3. If existing pending root bundle has passed its optimistic challenge liveness window, then execute it by calling functions on the `HubPool` and functions on each spoke network's `SpokePool`. Recall that each root bundle refers to a Merkle root describing the list of relayer and depositor refunds. Therefore, executing these refunds amounts to submitting Merkle leaves from this Merkle root to the HubPool/SpokePool and letting those contracts send out payments based on those Merkle leaf contents.
## Disputer watchdog bond maintenance

The disputer watchdog (`runDisputerWatchdog()` in index.ts) maintains the signer's HubPool bond
token (ABT) balance via `Disputer.validate()`: when the balance drops below a trigger level, it
wraps native token (`bondToken.deposit()`) to restore the balance to a target level, wrapping as
much of any shortfall as the native balance allows while keeping a small native reserve for gas.

- `BOND_BALANCE_TRIGGER` / `BOND_BALANCE_TARGET`: absolute levels in whole bond tokens
  (e.g. `15` / `20`). Set the trigger at or above any external balance-alerting thresholds
  (e.g. the monitor's `MONITORED_BALANCES` warn level) so the watchdog tops up before alerts fire.
- Unset: defaults to 4x (trigger) and 8x (target) the HubPool bond amount.
