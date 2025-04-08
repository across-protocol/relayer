# Rebalancer 2.0

This module is designed to be run as an independent bot whose core responsibility is to shift an `Account`'s balance between different networks in order to meet a configured allocation.

It is a re-imagining of the rebalancing algorithm currently enabled as a "mode" in the `src/relayer` module.

## Definitions

- `Account`: A cross-chain account.
  - `evmAddress`: `bytes20` address used on all EVM chains for this account
  - `svmAddress`: `bytes32` address used on all SVM chains
- `Hub`: A network or Centralized Exchange where an `Account` chooses to store excess inventory from which to rebalance to under-allocated chains. This should be something like the Ethereum network or the Binance API which has connections to all of the chains and tokens that htis bot is configured to run with.

## Configuration

- The user should supply a JSON conforming to the following format:
  - `token`: a symbol
    - `chainId`: a unique network ID
      - `minimumBalance`: the minimum USD-denominated amount of `Token` that should be held by the `Account` on this `ChainId`
      - `maximumBalance`: the maximum USD-denominated amount of `Token` that should be held by the `Account` on this `ChainId`

## Rebalancing Algorithm

The essential idea of this algorithm is for an Account to sweep excess balances (i.e. over the Maximum USD amount on a chain) into a "Hub" source of liquidity a

- For each `Account`:
- Query token balances on all chains
  - Convert all balances to USD value
- Identify chains that are underallocated and overallocated
- "Deposit" token balances from overallocated chains to the "Hub"
- Priority rank "underallocated" chains using some TBD heuristic
- "Withdraw" token balances to underallocated chains from the "Hub" in priority order until there is insufficient balance in the Hub

## Implementation

### `HubAdapter`

We have to create a different Adapter for each chain. As an illustrative example, let's imagine that we want to build a Binance HubAdapter that lets us house liquidity on a Binance spot account.

We need the "Withdraw" function to map to the Binance REST API `/withdraw` endpoint, and we need the "Deposit" function to be implemented as a transfer from an EOA to a Binance deposit address. The deposit and withdraw functions might need to be implemented differently for different chains, for example depositing from Solana to Binance will be different than from an EVM chain to Binance.

We would also need to be able to read our token balance on the Hub using the `/wallet/balances`. Finally, we need to track `/deposit/history` in order to identify pending deposits that to an underallocated chain that haven't finalized yet, so that we don't duplicate deposits out of the Hub.

#### Interface

- `deposit(amount: number, chainId: number): void`
- `withdraw(amount: number, chainId: number): void`
- `getHubBalance(): BigNumber`
- `getDeposits(): Deposit[]`
- `getWithdrawals(): Withdrawal[]`

### `TokenBalanceClient`

Queries token balances and converts them to USD amounts. Token balances should be summed from:

- current on-chain Token balance
- Upcoming relayer refunds of Tokens to chain

#### Interface

- `getUSDBalance(token: string, chainId: number): BigNumber`

### `AllocationManager`

Returns balances on all chains relative to the minimum and maximum thresholds. Will be used by Relayer to select the best repayment chain.

#### Interface

- `getAllocation(token: string, chainId: number): { minimum: BigNumber; maximum: BigNumber; balance: BigNumber }`

## Deployment Process

This module can be run in parallel to the existing `relayer/index.ts` "Rebalancer" module. We'll refer to this module as "Rebalancer 1.0" from now on. 

It will work best if the `Account` configured with this bot is either a separate EOA from the Rebalancer 1.0 or if the `Account` is configured to only rebalance on L2 chains that are not covered by the "Rebalancer 1.0". 

For example, this bot should work well out of the box on a brand new chain that the "Rebalancer 1.0" is not yet set up to work with, which is the first intended use case.

## Comparisons with Rebalancer 1.0

### Pros

- There is no need to track "pending" deposits from a chain to the Hub.
- Tracking balances instead of allocation percentages is simpler, and is not so sensitive to in-flight withdrawals that can skew the percentages temporarily
- Code will be easier to maintain because it is decoupled and completely independent of the Relayer

### Cons

- We still need to track "pending" withdrawals from the Hub to a chain so that we don't duplicate a withdrawal, and this tracking logic needs to be implemented once per Hub adapter.