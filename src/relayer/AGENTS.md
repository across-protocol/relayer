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

#### USDT->USDC in-protocol swaps relayer

In the future, the relayer bot should be able to support in-protocol swaps between many different types of assets. However, there are risk-management reasons why we are rolling this feature out slowly with the USDT->USDC relayer as the first instance of broader in-protocol swaps support.

First, read the "Filling in-protocol swaps" section on the the challenges facing relayers of in-protocol swaps.

Next, consider that supporting in-protocol swaps between stablecoins is a much easier problem than supporting swaps between any two arbitrary assets, because stablecoins can generally be assumed to have highly correlated prices that do not deviate permanently from each other.

Therefore, supporting swaps between USDT as an `inputToken` and USDC as an `outputToken` is a safe way to roll out the in-protocol swaps feature of the relayer and test out parts of the workflow without having to solve the problem of risk management related to price volatility between input and output tokens.

### USDC->USDH in-protocol swaps relayer

This relayer fulfills a similar role as the USDT->USDC relayer from the depositor's perspective, but its implemented very differently. Like the USDT->USDC relayer, this relayer holds USDH on the destination chain and fulfills deposits of USDC on supported origin chains.

Unlike the USDT->USDC relayer, this USDC->USDH relayer has a bespoke way of rebalancing from USDC back into USDH on HyperEVM. USDH is a stablecoin issued and controlled by the Native Markets team and this team provides a REST API with a /POST route that we can call to convert USDC directly into minted USDH on a desired destination chain. The API essentially provides us a deposit address on the desired origin chain where we can `ERC.transfer()` USDC to receive USDH on HyperEVM. 

Therefore, this USDC->USDH relayer is an even safer version of the USDT->USDC swaps relayer and it does not require an instance of the `RebalancerClient`, which uses Binance and Hyperliquid to execute cross chain inventory swap rebalances, in order to rebalance from USDC to USDH.
