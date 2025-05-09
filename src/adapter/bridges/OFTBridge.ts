import { Contract, ethers, Signer } from "ethers";
import { BridgeTransactionDetails, BaseBridgeAdapter, BridgeEvents } from "./BaseBridgeAdapter";
import {
  BigNumber,
  EventSearchConfig,
  Provider,
  TOKEN_SYMBOLS_MAP,
  isDefined,
  paginatedEventQuery,
  isContractDeployedToAddress,
  assert,
  EvmAddress,
  Address,
  resolveToken,
} from "../../utils";
import { processEvent } from "../utils";
import { CHAIN_IDs, PUBLIC_NETWORKS } from "@across-protocol/constants";
import { CONTRACT_ADDRESSES, IOFT_ABI_FULL } from "../../common";

import {
  IOFT,
  MessagingFeeStruct,
  SendParamStruct,
} from "@across-protocol/contracts/dist/typechain/contracts/interfaces/IOFT";

import { utils } from "@across-protocol/sdk";
const { toBytes32 } = utils;

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
  // Routes are organized by token address and destination chain ID
  private static readonly SUPPORTED_ROUTES: OFTRoutes = {
    // USDT supports transfers from Ethereum to Arbitrum
    [TOKEN_SYMBOLS_MAP.USDT.addresses[CHAIN_IDs.MAINNET]]: {
      [CHAIN_IDs.ARBITRUM]: {
        hubChainIOFTAddress: EvmAddress.from("0x6C96dE32CEa08842dcc4058c14d3aaAD7Fa41dee"),
        dstIOFTAddress: EvmAddress.from("0x14E4A1B13bf7F943c8ff7C51fb60FA964A298D92"),
      },
    },
  };

  // Cap the messaging fee to prevent excessive costs
  private static readonly FEE_CAP = ethers.utils.parseEther("0.1"); // 0.1 ether

  public readonly dstTokenAddress: string;

  // Bridge-specific properties
  private readonly dstChainEid: number;
  private readonly hubPoolAddress: string;
  private readonly tokenDecimals: number;
  private sharedDecimals?: number;

  /**
   * Creates an OFT bridge adapter for transfers between hub and destination chains.
   * @param dstChainId - Destination chain ID
   * @param hubChainId - Hub chain ID (must be Ethereum mainnet, 1)
   * @param hubSigner - Signer for the hub chain
   * @param dstSignerOrProvider - Signer or provider for the destination chain
   * @param hubTokenAddress - Token address on the hub chain
   */
  constructor(
    dstChainId: number,
    hubChainId: number,
    hubSigner: Signer,
    dstSignerOrProvider: Signer | Provider,
    public readonly hubTokenAddress: EvmAddress
  ) {
    // OFT bridge currently only supports Ethereum MAINNET as hub chain
    assert(
      hubChainId == CHAIN_IDs.MAINNET,
      new Error(`OFT bridge only supports Ethereum as hub chain, got chain ID: ${hubChainId}`)
    );

    const route = OFTBridge.SUPPORTED_ROUTES[hubTokenAddress.toAddress()]?.[dstChainId];
    assert(
      isDefined(route),
      new Error(`No route found for token ${hubTokenAddress.toAddress()} from chain ${hubChainId} to ${dstChainId}`)
    );

    super(dstChainId, hubChainId, hubSigner, dstSignerOrProvider, [route.hubChainIOFTAddress]);

    this.dstTokenAddress = this.resolveL2TokenAddress(hubTokenAddress);
    this.dstChainEid = getOFTEidForChainId(dstChainId);
    this.hubPoolAddress = CONTRACT_ADDRESSES[hubChainId]?.hubPool?.address;
    assert(isDefined(this.hubPoolAddress), `Hub pool address not found for chain ${hubChainId}`);
    this.l1Bridge = new Contract(route.hubChainIOFTAddress.toAddress(), IOFT_ABI_FULL, hubSigner);
    this.l2Bridge = new Contract(route.dstIOFTAddress.toAddress(), IOFT_ABI_FULL, dstSignerOrProvider);
    this.tokenDecimals = resolveToken(hubTokenAddress.toAddress(), hubChainId).decimals;
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
      new Error(
        `This bridge instance only supports token ${this.hubTokenAddress.toAddress()}, not ${l1Token.toAddress()}`
      )
    );

    // We round `amount` to a specific precision to prevent rounding on the contract side. This way, we
    // receive the exact amount we sent in the transaction
    const roundedAmount = await this.roundAmountToOftPrecision(amount);
    const sendParamStruct: SendParamStruct = {
      dstEid: this.dstChainEid,
      to: oftAddressToBytes32(toAddress.toAddress()),
      amountLD: roundedAmount,
      // @dev Setting `minAmountLD` equal to `amountLD` ensures we won't hit contract-side rounding
      minAmountLD: roundedAmount,
      extraOptions: "0x", // Empty bytes
      composeMsg: "0x", // Empty bytes
      oftCmd: "0x", // Empty bytes
    };

    // Get the messaging fee for this transfer
    const feeStruct: MessagingFeeStruct = await (this.l1Bridge as IOFT).quoteSend(sendParamStruct, false);
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
   * The last (tokenDecimals - sharedDecimals) digits must be zero to prevent rounding.
   * @param amount - Amount to round
   * @returns The amount rounded down to the correct precision
   */
  private async roundAmountToOftPrecision(amount: BigNumber): Promise<BigNumber> {
    this.sharedDecimals ??= await this.l1Bridge.sharedDecimals();

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
    // This shouldn't happen, but if request is for a different L1 token, return an empty list
    if (!l1Token.eq(this.hubTokenAddress)) {
      return {};
    }

    const isSpokePool = await isContractDeployedToAddress(toAddress.toAddress(), this.l2Bridge.provider);
    if (isSpokePool && fromAddress.toAddress() != this.hubPoolAddress) {
      return {};
    } else if (!fromAddress.eq(toAddress)) {
      return {};
    }

    // Get all OFTSent events for the fromAddress
    const allEvents = await paginatedEventQuery(
      this.l1Bridge,
      this.l1Bridge.filters.OFTSent(
        null, // guid - not filtering by guid (Topic[1])
        undefined, // dstEid - not an indexed parameter, must be `undefined`
        fromAddress.toAddress() // filter by `fromAddress`
      ),
      eventConfig
    );

    // Filter events by destination eid
    const events = allEvents.filter(({ args }) => args.dstEid === this.dstChainEid);

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
    // This shouldn't happen, but if request is for a different L1 token, return an empty list
    if (!l1Token.eq(this.hubTokenAddress)) {
      return {};
    }

    const isSpokePool = await isContractDeployedToAddress(toAddress.toAddress(), this.l2Bridge.provider);
    if (isSpokePool && fromAddress.toAddress() != this.hubPoolAddress) {
      return {};
    } else if (!fromAddress.eq(toAddress)) {
      return {};
    }

    // Get all OFTReceived events for the toAddress
    const allEvents = await paginatedEventQuery(
      this.l2Bridge,
      this.l2Bridge.filters.OFTReceived(
        null, // guid - not filtering by guid (Topic[1])
        undefined, // srcEid - not an indexed parameter, should be undefined
        toAddress.toAddress() // filter by `toAddress`
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

/**
 * Retrieves the OFT EID for a given chainId.
 * @param chainId - The chainId to get the OFT EID for
 * @returns The OFT EID for the given chainId
 */
export function getOFTEidForChainId(chainId: number): number {
  const eid = PUBLIC_NETWORKS[chainId].oftEid;
  if (!isDefined(eid)) {
    throw new Error(`No OFT domain found for chainId: ${chainId}`);
  }
  return eid;
}

/**
 * Converts an Ethereum address to bytes32 format for OFT bridge. Zero-pads from the left.
 * @param address - The Ethereum address to convert
 * @returns The bytes32 representation of the address
 */
export function oftAddressToBytes32(address: string): string {
  return toBytes32(address);
}
