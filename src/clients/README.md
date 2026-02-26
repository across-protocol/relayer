# Helper clients

## Event fetching clients

The SpokePoolClient and HubPoolClient are responsible for fetching events and state from the SpokePool and HubPool contracts.

These clients use cache management modules like the RedisClient in order to reduce event RPC request load and avoid rate-limits.

## Inventory Client

The InventoryClient has several important functions that all use its `InventoryConfig` as input

### Inventory Config

The full inventory config is defined in /src/interfaces/ and its read from the user's environment in the `src/relayer/RelayerConfig`. It essentially defines target balance allocation %'s across chains.

### Setting and Getting Virtual Balances

The InventoryClient is designed to track inventory across chains, which are actual on-chain token balances plus any virtual balance modifications stemming from incomplete transfers from the `CrossChainTransferClient` and incomplete rebalances from this `RebalancerClient`. The InventoryClient can also add in virtual modifications for upcoming relayer refunds from the `BundleDataApproxClient`.

The InventoryClient exposes functions that let other bots like the `Relayer` and `RebalancerClient` know its latest calculation of virtual chain balances for a particular token.

In addition to chain-level virtual balances, InventoryClient exposes cumulative token-level balance context via `getCumulativeBalanceWithApproximateUpcomingRefunds()`. The Rebalancer uses this to evaluate cumulative deficits and excesses when running cumulative inventory rebalancing.

### Determining Refund Chain for Deposit

Another important function of the InventoryClient is to choose where a relayer should get repaid for filling a particular deposit, which is purely a function of the user's configured "ideal" inventory across chains (i.e. defined in the `InventoryConfig`) and how the inventory state would look like post-filling the deposit.

Deep dives:

- `docs/repayment-eligibility.md`
- `docs/repayment-selection.md`
- `docs/inventory-virtual-balance-model.md`
- `docs/slow-fill-lifecycle.md`
- `docs/inventory-vs-rebalancer-responsibilities.md`

### Wrapping and Unwrapping Native Tokens

The InventoryConfig also lets the user set minimum native token balances to hold on all chains in order to avoid running out of gas for submitting on-chain transactions. Because the relayer is filling so many user deposits, it has a big demand for spending native token balance.

For now, the native token target balances are defined in the InventoryConfig and therefore the InventoryClient is in charge of determining when to and executing native token wraps and unwraps.

Ideally, this wrapping and unwrapping would occur in a separate, focused NativeTokenClient.

### Transferring Tokens Across Chains

The InventoryClient also provides functions that are used to transfer tokens across chains via adapters like CCTP, OFT, or canonical bridges. These adapters are defined in /src/adapter/bridges and /src/adapter/l2Bridges which send tokens from L1 to L2 and vice versa, respectively.

### Plan for Deprecation of Token Transfer Logic

Note that the InventoryClient is an older module and its token transfer functions are slated to be migrated over to the RebalancerClient eventually. For now, the separation of concerns between the two is that the InventoryClient is in charge of sending **same** tokens across chains while the RebalancerClient swaps different tokens across chains.

## Profit Client

Computes the relayer's expected profit from filling a deposit by converting the `inputAmount` of `inputTokens` and the `outputAmount` of `outputTokens` into a USD value.

The Profit Client estimates what the gas cost would be to fill the deposit (i.e. submit the fill function's call data) on the destination chain and factors this into its profitability calculation.

Importantly, the Profit CLient exposes certain configuration objects that the user can use to set profitability thresholds.

## Transaction Client

This client is responsible for submitting transactions on-chain and therefore for setting the transaction's gas price values, nonce, and implements important retry and error decoding logic. It is designed to be shared across all code modules that submit on-chain transactions.
