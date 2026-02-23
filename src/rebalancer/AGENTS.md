# AGENTS.md rebalancer

The Rebalancer is designed to be in charge of determining when the relayer's inventory of different tokens across different chains needs to be rebalanced and then executes these rebalances.

## RebalancerClient

The Rebalancer is a client defined in rebalancer.ts.

### Rebalance Routes

The Rebalancer client is instantiated with a list of `RebalanceRoutes` that show supported routes between a source token on a source chain and a destination token on a destination chain via some `RebalancerAdapter`.

The `RebalanceRoutes` are currently hardcoded in `RebalancerClientHelper.ts` but are designed to be configured more dynamically in the future.

### Rebalancer Adapter

These adapters are defined in `/adapters/` and each of them provide functions used to initiate cross chain rebalances via an exchange where source and destination tokens can be swapped for each other.

A full adapter should implement a method to initiate a rebalance, a method to return all pending rebalances, and a method to progress multi-stage rebalances through their lifecycle. Today, the interface is:

```ts
export interface RebalancerAdapter {
  // Called once to construct adapter.
  initialize(availableRoutes: RebalanceRoute[]): Promise<void>;
  // Called to initiate a rebalance.
  initializeRebalance(rebalanceRoute: RebalanceRoute, amountToTransfer: BigNumber): Promise<void>;
  // Called to progress all pending rebalances through their lifecycle.
  updateRebalanceStatuses(): Promise<void>;
  // Withdraws spare balance from Exchange back into account
  sweepIntermediateBalances(): Promise<void>;

  // Get all currently unfinalized rebalance amounts. Should be used to add a virtual balance credit for the chain
  // + token in question. Designed to be used by InventoryClient
  // to get more accurate virtual balances
  getPendingRebalances(): Promise<{ [chainId: number]: { [token: string]: BigNumber } }>;
  // Returns unique ID list of all pending rebalances.
  getPendingOrders(): Promise<string[]>;
  // Returns approximate cost to rebalance via rebalance route.
  getEstimatedCost(rebalanceRoute: RebalanceRoute, amountToTransfer: BigNumber, debugLog: boolean): Promise<BigNumber>;
}
```

The adapters currently are only for swapping between different input and output tokens, but there are partially written CCTP and OFT adapters that we plan to turn into full adapters capable of transferring same tokens across chains, in the same way that we use the `InventoryClient` and the `CrossChainTransferClient` today to send USDC via CCTP and USDT0 via OFT.

The full adapters implemented so far are:

- Binance: Swaps tokens via Binance Exchange API
- Hyperliquid: Swaps tokens via Hyperliquid Exchange API and on-chain helper smart contracts

#### BaseAdapter

The BaseAdapter in /adapters/baseAdapter.ts is currently used as the parent client for all adapters in /adapters. It uses Redis to keep track of pending rebalance state, which is vital since rebalances are all multi-stage and without bespoke tracking of rebalances it would be very difficult to use the exchange API's to keep track of our balances and our intended cross-chain rebalances.

One way to think about why persisting rebalance status is so important is that the exchanges are unaware of our Rebalancer's original intention to send tokens into an exchange. For example, if we send USDC into an exchange, it is impossible for us to add a note to the USDC deposit that this deposit is "for swapping into USDT and for withdrawing on X network".

## Determining when to rebalance

The Rebalancer is configured by environment variables used as input to construct a `RebalancerConfig`. The rebalancer config lets the user set `targetBalances` for each token and chain which define a target and a threshold balance as well as a `priority` level for that specific target balance.

Deficit and excess balances are determined and then sorted according to the heuristic in `RebalancerClient.rebalanceInventory()`. The current heuristic sorts deficits first by `priority` in ascending order (smallest priority is ranked highest) and then ties are broken by largest deficits (i.e. balances most below their targets). Excesses are sorted in opposite order, by `priority` in descending order and then by largest excesses (i.e. balances most above their target).

Once all deficits and excess balances are collected, deficits are iterated through in order and if there is an excess balance that has enough balance to fulfill the deficit, and if there is a supported `RebalanceRoute` that connects `excess` tokens on the excess chain to `deficit` tokens on the deficit chain, then a rebalance is initiated via the `RebalanceRoute.adapter.initiateRebalance()` function.

### Deficit Balances

When the Rebalancer reads that its balances of a token on a specific chain have fallen below the theshold, then the rebalancer will attempt to use inventory of other tokens to replenish its balance back to its target. These balances that have fallen below their thresholds are called "deficit balances". Deficit values are equal to `target - balance`.

### Excess Balances

Opposite to deficit balances, excess balances are token balances that are greater than their targets. Excess values are equal to `balance - target`.

## Creating a new Rebalancer instance

Rebalancers are constructed most easily via the `constructRebalancerClient()` function in `RebalancerClientHelper.ts`. This helper method is similar to the `RelayerClientHelper` or other files containing the suffix `ClientHelper` because they first construct all helper clients for fetching important events and reading API state.

This function then constructs a new RebalancerClient instance and then runs prerequisite functions that are required before using the new client, like calling `initialize()` on the new client.

## Interactivity with other bots and clients

The RebalancerClient is designed to work side by side with the InventoryClient and the Relayer. It also benefits from the Binance finalizer defined in `/src/finalizer/utils/binance.ts`.

### InventoryClient

The InventoryClient is designed to track inventory across chains, which are actual on-chain token balances plus any virtual balance modifications like those stemming from incomplete incomplete rebalances from this RebalancerClient.

The InventoryClient's methods that return a chain's virtual balances are also used by the RebalancerClient in order to determine whether a chain's virtual balances are in deficit or excess relative to the user-configured targets.

### Relayer

The relayer can better support in-protocol swaps when a Rebalancer instance is being run so that any cross-token inventory allocations can be unwound via the Rebalancer functions.

### Binance Finalizer

The Binance finalizer occasionally sweeps all binance balances back to a hardcoded account. The Rebalancer's Binance Adapter is smart enough to flag certain transfers into Binance as designated for swapping which lets the Binance finalizer know not to sweep these transfers back for some time. However, when that time expires (e.g. after 30 minutes), the binance finalizer is relied upon to sweep any balances. This effectively acts as a fallback in case the Binance Adapter fails to complete its rebalance.