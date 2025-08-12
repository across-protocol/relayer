import { BigNumberish, BytesLike, Contract, Signer } from "ethers";
import { BridgeTransactionDetails, BaseBridgeAdapter, BridgeEvents } from "./BaseBridgeAdapter";
import {
  BigNumber,
  EventSearchConfig,
  Provider,
  TOKEN_SYMBOLS_MAP,
  fetchTokenInfo,
  isDefined,
  paginatedEventQuery,
  assert,
  EvmAddress,
  Address,
  toBytes32,
  toWei,
  isContractDeployedToAddress,
  winston,
} from "../../utils";
import { processEvent } from "../utils";
import { CHAIN_IDs, PUBLIC_NETWORKS } from "@across-protocol/constants";
import { CONTRACT_ADDRESSES, IOFT_ABI_FULL } from "../../common";

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

type OFTRouteInfo = {
  hubChainIOFTAddress: EvmAddress;
  dstIOFTAddress: EvmAddress;
};

type OFTRoutes = {
  [tokenAddress: string]: {
    [dstChainId: number]: OFTRouteInfo;
  };
};

export class OFTBridge extends BaseBridgeAdapter {
  // Routes from Ethereum MAINNET per token and per destination chain
  private static readonly SUPPORTED_ROUTES: OFTRoutes = {
    // USDT must be transferred via OFT from Ethereum to Arbitrum
    [TOKEN_SYMBOLS_MAP.USDT.addresses[CHAIN_IDs.MAINNET]]: {
      [CHAIN_IDs.ARBITRUM]: {
        hubChainIOFTAddress: EvmAddress.from("0x6C96dE32CEa08842dcc4058c14d3aaAD7Fa41dee"),
        dstIOFTAddress: EvmAddress.from("0x14E4A1B13bf7F943c8ff7C51fb60FA964A298D92"),
      },
    },
  };

  // Cap the messaging fee to prevent excessive costs
  private static readonly FEE_CAP = toWei("0.1"); // 0.1 ether

  private readonly hubPoolAddress: string;
  public readonly dstTokenAddress: string;
  private readonly dstChainEid: number;
  private tokenDecimals?: number;
  private sharedDecimals?: number;

  constructor(
    dstChainId: number,
    hubChainId: number,
    hubSigner: Signer,
    dstSignerOrProvider: Signer | Provider,
    public readonly hubTokenAddress: EvmAddress,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _logger: winston.Logger
  ) {
    // OFT bridge currently only supports Ethereum MAINNET as hub chain
    assert(
      hubChainId == CHAIN_IDs.MAINNET,
      `OFT bridge only supports Ethereum as hub chain, got chain ID: ${hubChainId}`
    );

    const route = OFTBridge.SUPPORTED_ROUTES[hubTokenAddress.toNative()]?.[dstChainId];
    assert(
      isDefined(route),
      `No route found for token ${hubTokenAddress.toNative()} from chain ${hubChainId} to ${dstChainId}`
    );

    super(dstChainId, hubChainId, hubSigner, [route.hubChainIOFTAddress]);

    this.hubPoolAddress = CONTRACT_ADDRESSES[hubChainId]?.hubPool?.address;
    assert(isDefined(this.hubPoolAddress), `Hub pool address not found for chain ${hubChainId}`);
    this.dstTokenAddress = this.resolveL2TokenAddress(hubTokenAddress);
    this.dstChainEid = getOFTEidForChainId(dstChainId);
    this.l1Bridge = new Contract(route.hubChainIOFTAddress.toNative(), IOFT_ABI_FULL, hubSigner);
    this.l2Bridge = new Contract(route.dstIOFTAddress.toNative(), IOFT_ABI_FULL, dstSignerOrProvider);
  }

  async constructL1ToL2Txn(
    toAddress: Address,
    l1Token: EvmAddress,
    _l2Token: Address,
    amount: BigNumber
  ): Promise<BridgeTransactionDetails> {
    // Verify the token matches the one this bridge was constructed for
    assert(
      l1Token.eq(this.hubTokenAddress),
      `This bridge instance only supports token ${this.hubTokenAddress.toNative()}, not ${l1Token.toNative()}`
    );

    assert(
      toAddress.isEVM(),
      `OFTBridge only supports sending to EVM addresses. Dst address supplied ${toAddress.toNative()} is not EVM.`
    );

    // We round `amount` to a specific precision to prevent rounding on the contract side. This way, we
    // receive the exact amount we sent in the transaction
    const roundedAmount = await this.roundAmountToOftPrecision(amount);
    const sendParamStruct: SendParamStruct = {
      dstEid: this.dstChainEid,
      to: oftAddressToBytes32(toAddress),
      amountLD: roundedAmount,
      // @dev Setting `minAmountLD` equal to `amountLD` ensures we won't hit contract-side rounding
      minAmountLD: roundedAmount,
      extraOptions: "0x",
      composeMsg: "0x",
      oftCmd: "0x",
    };

    // Get the messaging fee for this transfer
    const feeStruct: MessagingFeeStruct = await this.getL1Bridge().quoteSend(sendParamStruct, false);
    if (BigNumber.from(feeStruct.nativeFee).gt(OFTBridge.FEE_CAP)) {
      throw new Error(`Fee exceeds maximum allowed (${feeStruct.nativeFee} > ${OFTBridge.FEE_CAP})`);
    }

    // Set refund address to signer's address. This should technically never be required as all of our calcs
    // are precise, set it just in case
    const refundAddress = await this.l1Bridge.signer.getAddress();
    return {
      contract: this.l1Bridge,
      method: "send",
      args: [sendParamStruct, feeStruct, refundAddress],
      value: BigNumber.from(feeStruct.nativeFee),
    };
  }

  /**
   * Rounds the token amount down to the correct precision for OFT transfer.
   * The last (tokenDecimals - sharedDecimals) digits must be zero to prevent contract-side rounding.
   * @param amount - Amount to round
   * @returns The amount rounded down to the correct precision
   */
  private async roundAmountToOftPrecision(amount: BigNumber): Promise<BigNumber> {
    // Fetch `sharedDecimals` if not already fetched
    this.sharedDecimals ??= await this.l1Bridge.sharedDecimals();
    // Same for `tokenDecimals`
    this.tokenDecimals ??= (await fetchTokenInfo(this.hubTokenAddress.toNative(), this.l1Bridge.signer)).decimals;

    const decimalDifference = this.tokenDecimals - this.sharedDecimals;

    if (decimalDifference > 0) {
      const divisor = BigNumber.from(10).pow(decimalDifference);
      const remainder = amount.mod(divisor);
      return amount.sub(remainder);
    }

    return amount;
  }

  async queryL1BridgeInitiationEvents(
    l1Token: EvmAddress,
    fromAddress: Address,
    toAddress: Address,
    eventConfig: EventSearchConfig
  ): Promise<BridgeEvents> {
    // Return no events if the query is for a different l1 token
    if (!l1Token.eq(this.hubTokenAddress)) {
      return {};
    }

    // Return no events if the query is for hubPool
    if (fromAddress.eq(EvmAddress.from(this.hubPoolAddress))) {
      return {};
    }

    const isSpokePool = await isContractDeployedToAddress(toAddress.toNative(), this.l2Bridge.provider);
    const fromHubEvents = await paginatedEventQuery(
      this.l1Bridge,
      this.l1Bridge.filters.OFTSent(
        null, // guid - not filtering by guid (Topic[1])
        undefined, // dstEid - not an indexed parameter, must be `undefined`
        // If the request is for a spoke pool, return `OFTSent` events from hubPool
        isSpokePool ? this.hubPoolAddress : fromAddress.toNative()
      ),
      eventConfig
    );

    // Filter events by destination eid. This gives us [hubPool -> dst_chain] events, which are [hubPool -> dst_spoke] events we were looking for
    const events = fromHubEvents.filter(({ args }) => args.dstEid === this.dstChainEid);

    return {
      [this.dstTokenAddress]: events.map((event) => {
        return processEvent(event, "amountReceivedLD");
      }),
    };
  }

  async queryL2BridgeFinalizationEvents(
    l1Token: EvmAddress,
    fromAddress: Address,
    toAddress: Address,
    eventConfig: EventSearchConfig
  ): Promise<BridgeEvents> {
    // Return no events if the query is for a different l1 token
    if (!l1Token.eq(this.hubTokenAddress)) {
      return {};
    }

    // Return no events if the query is for hubPool
    if (fromAddress.eq(EvmAddress.from(this.hubPoolAddress))) {
      return {};
    }

    // Get `OFTReceived` events for [hub chain -> toAddress]
    const allEvents = await paginatedEventQuery(
      this.l2Bridge,
      this.l2Bridge.filters.OFTReceived(
        null, // guid - not filtering by guid (Topic[1])
        undefined, // srcEid - not an indexed parameter, should be undefined
        toAddress.toNative() // filter by `toAddress`
      ),
      eventConfig
    );

    // Filter events by source eid
    const sourceEid = getOFTEidForChainId(this.hubChainId);
    const events = allEvents.filter((event) => event.args.srcEid === sourceEid);

    return {
      [this.dstTokenAddress]: events.map((event) => {
        return processEvent(event, "amountReceivedLD");
      }),
    };
  }
}

// Retrieves the OFT EID for a given chainId.
export function getOFTEidForChainId(chainId: number): number {
  const eid = PUBLIC_NETWORKS[chainId].oftEid;
  if (!isDefined(eid)) {
    throw new Error(`No OFT domain found for chainId: ${chainId}`);
  }
  return eid;
}

// Converts an EVM address to bytes32 format for OFT bridge. Zero-pads from the left.
export function oftAddressToBytes32(address: EvmAddress): string {
  return toBytes32(address.toNative());
}
