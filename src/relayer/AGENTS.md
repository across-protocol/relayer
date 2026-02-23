# AGENTS.md - relayer

## Configuration

The Relayer can be configured to only fill deposits from certain origin chains and input tokens and on certain destination chains and output tokens.

The Relayer's profitabilty threshold can also be modified.

The Relayer inherently assumes finality risk the faster it attempts to fill an unfilled deposit, for if the deposit has not finalized before the fill transaction is sent, the relayer risks that the deposit is re-orged and their fill becomes invalid.

Therefore, the relayer's finality risk threshold can be customized as well.

The full config can be found in `RelayerConfig.ts`

## Constructing a Relayer

The functions in `RelayerClientHelper` provide convenient functions for creating all of the helper clients that the Relayer needs to run, updating and initializing them, and then constructing a new Relayer.

## Core runtime flow

The Relayer fetches unfilled deposits, filters for the deposits that it deems profitable and fillable according to its user-defined configuration, and then fills the deposits--batching its fill functions on destination chains where possible.

For each fill, the Relayer must determine where it wants to be refunded for filling the deposit after the relayer's refund is processed in the next root bundle. The `InventoryClient` makes this decision for the relayer.

The runtime can be found in `index.ts`.

## Challenges

### Filling deposits for equivalent tokens

If the deposit's input and output tokens are equivalent then the relayer takes on no price risk and chance of permanent loss, but the relayer might not be able to get refunded the token on the same destination chain where it transferred out tokens to the depositor.

Therefore, the relayer faces an inventory re-allocation challenge where due to filling the deposit, the relayer's inventory has shifted. Therefore, the `InventoryClient` is used to determine how far the relayer's inventory has shifted from its ideal state and which actions to take to move its inventory around.

### Filling in-protocol swaps

Consider that filling a deposit where the `inputToken` and `outputToken` are different assets results in the relayer getting refunded the `inputToken` while sending the user the `outputToken`. Over time, the relayer would accumulate more `inputTokens` than its starting inventory and would run out of `outputTokens`. Therefore, the relayer must decide when to rebalance from `inputTokens` back into `outputTokens` in order to get back to its starting inventory position. If the relayer does not rebalance like this, then the relayer will eventually be unable to fulfill deposits for this `outputToken` anymore because it will have no more `outputToken` balance.

Rebalancing amounts to swapping between input and output token. One difficulty with swapping is that the input token and output tokens exist on different chains, namely wherever the relayer chooses to (or is forced to by the protocol to) take repayment and wherever the depositor sets their destination chain. Therefore, swaps must be performed in such a manner that input tokens on the refund chain are transformed into output tokens on the desired destination chain. Another difficulty is that swapping involves trading spread fees. The final difficulty is perhaps the most complex and it is that the input and output tokens might have prices that are uncorrelated and could deviate permanently over time. 

For example, imagine that the input token is ETH and the output token is a stablecoin and ETH obviously can deviate from a stablecoin's price quickly. Therefore, if the rebalance is not performed by the relayer quickly or strategically, then the relayer can realize a permanent loss in USD terms.

Therefore, supporting in-protocol swaps requires that the relayer has a module for deciding when to rebalance and how to mitigate this risk of permanent loss. This is closely related to the risk management problems that traditional "market makers" face and there are several approaches to this problem.