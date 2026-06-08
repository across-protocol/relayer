import { utils as sdkUtils } from "@across-protocol/sdk";
import { CHAIN_IDs, TOKEN_SYMBOLS_MAP } from "@across-protocol/constants";
import { Address, compareAddressesSimple } from ".";

/**
 * Returns true if `(chainId, token)` can be drained off via an unmetered, low-latency bridge
 * (CCTP for USDC, OFT for USDT, or the hub chain itself via canonical bridges).
 *
 * Pure over the static CCTP/OFT chain registries plus a single hub-chain id, so it's safe to
 * call without taking a dependency on InventoryClient.
 */
export function isUnmeteredFastRebalance(chainId: number, token: Address, hubChainId: number): boolean {
  const cctp =
    sdkUtils.chainIsCCTPEnabled(chainId) &&
    compareAddressesSimple(TOKEN_SYMBOLS_MAP.USDC.addresses[chainId], token.toNative());
  // OFT withdrawals from HyperEVM take ~12h, so they aren't fast.
  const oft =
    sdkUtils.chainIsOFTEnabled(chainId) &&
    compareAddressesSimple(TOKEN_SYMBOLS_MAP.USDT.addresses[chainId], token.toNative()) &&
    chainId !== CHAIN_IDs.HYPEREVM;
  return cctp || oft || chainId === hubChainId;
}
