import { OFT_NO_EID } from "@across-protocol/constants";
import { BigNumber, BigNumberish, EvmAddress, PUBLIC_NETWORKS, assert, isDefined } from ".";
import { BytesLike } from "ethers";
import { EVM_OFT_MESSENGERS } from "../common/Constants";

export type SendParamStruct = {
  dstEid: BigNumberish;
  to: BytesLike;
  amountLD: BigNumberish;
  minAmountLD: BigNumberish;
  extraOptions: BytesLike;
  composeMsg: BytesLike;
  oftCmd: BytesLike;
};

export type MessagingFeeStruct = {
  nativeFee: BigNumberish;
  lzTokenFee: BigNumberish;
};

/**
 * @returns Endpoint Id for a given chain
 * @throws If oftEid is not defined for a chain or equal to OFT_NO_EID
 */
export function getEndpointId(chainId: number): number {
  const eid = PUBLIC_NETWORKS[chainId].oftEid;
  if (!isDefined(eid) || eid == OFT_NO_EID) {
    throw new Error(`No OFT domain found for chainId: ${chainId}`);
  }
  return eid;
}

/**
 * @returns IOFT messenger for a given chain. Only supports EVM chains for now
 * @throws If EVM_OFT_MESSENGERS mapping doesn't have an entry for the l1Token - chainId combination
 */
export function getMessengerEvm(l1TokenAddress: EvmAddress, chainId: number): EvmAddress {
  const messenger = EVM_OFT_MESSENGERS.get(l1TokenAddress.toNative())?.get(chainId);
  assert(isDefined(messenger), `No OFT messenger configured for ${l1TokenAddress.toNative()} on chain ${chainId}`);
  return messenger;
}

/**
 * @param receiver Address to receive the OFT transfer on target chain
 * @returns A 32-byte string to be used when calling on-chain OFT contracts
 */
export function formatToAddress(receiver: EvmAddress): string {
  return receiver.toBytes32();
}

/**
 * Rounds the token amount down to the correct precision for OFT transfer.
 * The last (tokenDecimals - sharedDecimals) digits must be zero to prevent contract-side rounding.
 * @param amount amount to round
 * @param tokenDecimals decimals of the token we're sending
 * @param sharedDecimals queried from the OFT contract. Shared decimals between OFT tokens on different chains
 * @returns The amount rounded down to the correct precision
 */
export function roundAmountToSend(amount: BigNumber, tokenDecimals: number, sharedDecimals: number): BigNumber {
  const decimalDifference = tokenDecimals - sharedDecimals;
  if (decimalDifference > 0) {
    const divisor = BigNumber.from(10).pow(decimalDifference);
    const remainder = amount.mod(divisor);
    return amount.sub(remainder);
  }
  return amount;
}

/**
 * @notice Build a minimal OFT SendParam for EVM transfers with dust-safe amounts.
 * @param to EVM address on the destination chain to receive the tokens
 * @param dstEid OFT endpoint ID for the destination chain
 * @param roundedAmount Token amount in local decimals with dust removed (amountLD == minAmountLD)
 * @returns Struct suitable for IOFT.send/quoteSend
 */
export function buildSimpleSendParamEvm(to: EvmAddress, dstEid: number, roundedAmount: BigNumber): SendParamStruct {
  return {
    dstEid,
    to: formatToAddress(to),
    amountLD: roundedAmount,
    minAmountLD: roundedAmount,
    extraOptions: "0x",
    composeMsg: "0x",
    oftCmd: "0x",
  };
}
