# Refiller

The Refiller client allows the user to configure target balances of tokens and then provides methods to refill balances that have fallen below those targets.

Unlike the `InventoryClient`, the refiller was originally designed to handle refilling balances on the same-chain and not send cross-chain transfers.

The primary use case for the refiller originally was to send native token balances from one bot's EOA to another. When combining this logic with the InventoryClient's wrapping and unwrapping of native token functions, we can ensure that bot native tokens never get too low.

## Refilling USDH on HyperEVM

The Refiller also has a function that lets it transfer USDC from Arbitrum and mint USDH on HyperEVM via the NativeMarkets API.

The reason why this function was originally located in this Refiller client is because initiating this USDH "refill" starts with an ERC20 transfer, much like some of the other refill functions in the Refiller. So, there is some code-reuse here.

However, ideally this logic for refilling USDH is moved into a separate client. Perhaps it should be located in the RebalancerClient since its function is shift cross-chain token inventory like the RebalancerClient's other adapters.