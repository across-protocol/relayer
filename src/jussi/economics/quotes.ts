import { IOFT_ABI_FULL, LZ_FEE_TOKENS } from "../../common";
import { Options } from "@layerzerolabs/lz-v2-utilities";
import {
  BigNumber,
  CHAIN_IDs,
  Contract,
  EvmAddress,
  SendParamStruct,
  Signer,
  TOKEN_SYMBOLS_MAP,
  assert,
  chainHasNativeToken,
  formatToAddress,
  getEndpointId,
  getMessengerEvm,
  getProvider,
  isDefined,
  roundAmountToSend,
} from "../../utils";
import { DEFAULT_HUB_POOL_CHAIN_ID, MONAD_EXECUTOR_LZ_RECEIVE_GAS_LIMIT } from "../constants";
import type { GraphEdgeCandidate, OftQuoteReader, OftRouteTransferQuote } from "../types";

export function resolveOftQuoteSendFeeAsset(chainId: number): string {
  assert(
    !chainHasNativeToken(chainId),
    `OFT fee asset override is only required for non-native fee chains: ${chainId}`
  );
  const lzFeeToken = LZ_FEE_TOKENS[chainId];
  assert(isDefined(lzFeeToken), `Missing LZ fee token mapping for OFT chain ${chainId}`);
  return lzFeeToken.toNative();
}

export function resolveOftQuoteExtraOptions(destinationChain: number): SendParamStruct["extraOptions"] {
  return destinationChain === CHAIN_IDs.MONAD
    ? Options.newOptions().addExecutorLzReceiveOption(MONAD_EXECUTOR_LZ_RECEIVE_GAS_LIMIT).toBytes()
    : "0x";
}

export async function quoteOftRouteTransfer(params: {
  reader: OftQuoteReader;
  originChain: number;
  destinationChain: number;
  sourceDecimals: number;
  recipient: EvmAddress;
  amount: BigNumber;
}): Promise<OftRouteTransferQuote> {
  const { reader, originChain, destinationChain, sourceDecimals, recipient, amount } = params;
  const sharedDecimals = await reader.sharedDecimals();
  const roundedAmount = roundAmountToSend(amount, sourceDecimals, sharedDecimals);
  const sendParamStruct: SendParamStruct = {
    dstEid: getEndpointId(destinationChain),
    to: formatToAddress(recipient),
    amountLD: roundedAmount,
    minAmountLD: roundedAmount,
    extraOptions: resolveOftQuoteExtraOptions(destinationChain),
    composeMsg: "0x",
    oftCmd: "0x",
  };
  const quoteOftResult = (await reader.quoteOFT(sendParamStruct)) as unknown as [
    unknown,
    Array<{ feeAmountLD: BigNumber | string; description: string }>,
    { amountReceivedLD: BigNumber | string },
  ];
  const amountReceivedDestinationNative = BigNumber.from(quoteOftResult[2].amountReceivedLD);
  const finalSendParamStruct: SendParamStruct = {
    ...sendParamStruct,
    minAmountLD: amountReceivedDestinationNative,
  };
  const messageFeeIsNative = chainHasNativeToken(originChain);
  const feeStruct = await reader.quoteSend(finalSendParamStruct, !messageFeeIsNative);
  const messageFeeAmount = messageFeeIsNative ? feeStruct.nativeFee : feeStruct.lzTokenFee;

  return {
    roundedInputSourceNative: roundedAmount,
    amountReceivedDestinationNative,
    ...(messageFeeIsNative ? {} : { messageFeeAssetAddress: resolveOftQuoteSendFeeAsset(originChain) }),
    messageFeeAmount: BigNumber.from(messageFeeAmount),
    messageFeeIsNative,
    sendParamStruct: finalSendParamStruct,
  };
}

export async function quoteLiveOftRouteTransfer(
  candidate: GraphEdgeCandidate,
  amount: BigNumber,
  baseSigner: Signer,
  hubPoolChainId = DEFAULT_HUB_POOL_CHAIN_ID
): Promise<OftRouteTransferQuote> {
  const l1Token = EvmAddress.from(TOKEN_SYMBOLS_MAP[candidate.from.logicalAsset].addresses[hubPoolChainId]);
  const originProvider = await getProvider(candidate.from.chainId);
  const messengerAddress = getMessengerEvm(l1Token, candidate.from.chainId, candidate.to.chainId);
  const reader = new Contract(messengerAddress.toNative(), IOFT_ABI_FULL, originProvider) as unknown as OftQuoteReader;

  return quoteOftRouteTransfer({
    reader,
    originChain: candidate.from.chainId,
    destinationChain: candidate.to.chainId,
    sourceDecimals: candidate.from.decimals,
    recipient: EvmAddress.from(await baseSigner.getAddress()),
    amount,
  });
}
