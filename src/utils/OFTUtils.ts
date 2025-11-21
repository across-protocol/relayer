import axios from "axios";
import { Options } from "@layerzerolabs/lz-v2-utilities";
import { BytesLike, Contract, utils as ethersUtils } from "ethers";
import { PRODUCTION_OFT_EIDs, OFT_NO_EID } from "@across-protocol/constants";
import { SortableEvent } from "../interfaces";
import LZEndpoint from "../common/abi/LayerZeroV2Endpoint.json";
import { EVM_OFT_MESSENGERS } from "../common";
import {
  Address,
  BigNumber,
  BigNumberish,
  EventSearchConfig,
  EvmAddress,
  PUBLIC_NETWORKS,
  assert,
  isDefined,
  CHAIN_IDs,
  paginatedEventQuery,
  Provider,
  spreadEventWithBlockNumber,
} from ".";

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
  nativeFee: BigNumber;
  lzTokenFee: BigNumberish;
};

export type LzTransactionDetails = {
  source: LzSourceTransactionDetails;
  destination: LzDestinationTransactionDetails;
  pathway: Pathway;
  guid: string;
};

export type LzSourceTransactionDetails = { status: string; tx: { payload: string } };
export type LzDestinationTransactionDetails = { status: string; failedTx: TransactionOutcome[] };

export type LzBridgeEvent = SortableEvent;

type TransactionOutcome = {
  txHash: string;
  txError: string;
  blockHash: string;
  blockNumber: string;
  revertReason: string;
};

type Pathway = {
  srcEid: number;
  dstEid: number;
  sender: {
    address: string;
  };
  receiver: {
    address: string;
  };
  nonce: number;
  source: {
    payload: string;
  };
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
 * @param endpoint ID The OFT endpoint ID for the given chain.
 * @returns The endpoint's corresponding chain ID.
 * @throws If oftEid is not defined for a chain or equal to OFT_NO_EID.
 */
export function getChainIdFromEndpointId(eid: number): number {
  const chain = Object.entries(PUBLIC_NETWORKS).find(([, network]) => network.oftEid === eid);
  return Number(chain[0]);
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
 * @param chainId The chain Id of the network to check
 * @returns If the input chain ID's OFT adapter requires payment in the input token.
 */
export function isStargateBridge(chainId: number): boolean {
  return [CHAIN_IDs.PLASMA].includes(chainId);
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
 * Boosts the gas limit for an LZv2 send call, based on the destination chain.
 * @param dstEid Destination chain EID.
 * @returns A byte string for use for LZv2 send extraOpts.
 */
export function boostGasLimit(dstEid: number): string {
  // Monad needs a boosted gas limit over the default 80k. The default may be lifted by LZ. @todo: Check.
  const gas = {
    [PRODUCTION_OFT_EIDs.MONAD]: 500000,
  };

  const gasBoost = gas[dstEid];
  if (!gasBoost) {
    return "0x";
  }

  return ethersUtils.hexlify(Options.newOptions().addExecutorLzReceiveOption(gasBoost).toBytes());
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
    extraOptions: boostGasLimit(dstEid),
    composeMsg: "0x",
    oftCmd: "0x",
  };
}

/**
 * @notice Fetches destination chain transaction details for a outbound message.
 * @param txHash Transaction hash of the outbound message on the origin chain.
 * @returns Message data as outlined in these docs: https://docs.layerzero.network/v2/concepts/troubleshooting/debugging-messages#response-shape.
 */
export async function getLzTransactionDetails(txHash: string): Promise<LzTransactionDetails> {
  const httpResponse = await axios.get<LzTransactionDetails>(`https://scan.layerzero-api.com/v1/messages/tx/${txHash}`);
  const txDetails = httpResponse.data;
  return txDetails;
}

export async function getOFTSent(
  chainId: number,
  token: Address,
  searchConfig: EventSearchConfig,
  provider: Provider
): Promise<SortableEvent[]> {
  const oftAddr = EVM_OFT_MESSENGERS.get(token.toNative())?.get(chainId);
  if (!oftAddr) {
    return [];
  }

  const abi = new ethersUtils.Interface(LZEndpoint);
  const oftAdapter = new Contract(oftAddr.toNative(), abi, provider);
  const filter = oftAdapter.filters.OFTSent();
  return (await paginatedEventQuery(oftAdapter, filter, searchConfig)).map(spreadEventWithBlockNumber);
}
