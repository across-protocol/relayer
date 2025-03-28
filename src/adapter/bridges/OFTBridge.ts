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
} from "../../utils";
import { processEvent } from "../utils";
import { CHAIN_IDs, PUBLIC_NETWORKS } from "@across-protocol/constants";
import { CONTRACT_ADDRESSES } from "../../common";

import { IOFT_ABI_FULL } from "../../common";

import {
  IOFT,
  MessagingFeeStruct,
  SendParamStruct,
} from "@across-protocol/contracts/typechain/contracts/interfaces/IOFT";
import { resolveToken } from "../../../scripts/utils";

export type OFTRouteInfo = {
  hubChainIOFTAddress: string;
  dstIOFTAddress: string;
};

// Routes are organized by token address and destination chain ID
export type OFTRoutes = {
  [tokenAddress: string]: {
    [dstChainId: number]: OFTRouteInfo;
  };
};

export class OFTBridge extends BaseBridgeAdapter {
  // Structure: { tokenAddress: { dstChainId: OFTRouteInfo } }
  private static readonly SUPPORTED_ROUTES: OFTRoutes = {
    // USDT supports transfers from Ethereum to Arbitrum
    [TOKEN_SYMBOLS_MAP.USDT.addresses[CHAIN_IDs.MAINNET]]: {
      [CHAIN_IDs.ARBITRUM]: {
        hubChainIOFTAddress: "0x6C96dE32CEa08842dcc4058c14d3aaAD7Fa41dee",
        dstIOFTAddress: "0x14E4A1B13bf7F943c8ff7C51fb60FA964A298D92",
      },
    },
  };

  // Maximum amount of tokens that can be sent in a single transaction (hardcoded safety limit)
  private static readonly MAX_AMOUNT = ethers.utils.parseUnits("100000.0", 6); // 100K USDT
  // Cap the messaging fee to prevent excessive costs
  private static readonly FEE_CAP = ethers.utils.parseEther("0.1"); // 0.1 ether

  // Bridge-specific properties
  private readonly hubTokenAddress: string;
  private readonly dstTokenAddress: string;
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
   * @param hubChainToken - Token address on the hub chain
   */
  constructor(
    dstChainId: number,
    hubChainId: number,
    hubSigner: Signer,
    dstSignerOrProvider: Signer | Provider,
    hubChainToken: string
  ) {
    // OFT bridge currently only supports Ethereum as hub chain
    if (hubChainId !== CHAIN_IDs.MAINNET) {
      throw new Error(`OFT bridge only supports Ethereum as hub chain, got chain ID: ${hubChainId}`);
    }

    // Check if the route exists for this token and chain
    const route = OFTBridge.SUPPORTED_ROUTES[hubChainToken]?.[dstChainId];
    if (!isDefined(route)) {
      throw new Error(`No route found for token ${hubChainToken} from chain ${hubChainId} to ${dstChainId}`);
    }

    // todo: do we really want to approve every supported IOFT for `export const MAX_SAFE_ALLOWANCE = "79228162514264337593543950335";`?
    super(dstChainId, hubChainId, hubSigner, dstSignerOrProvider, [route.hubChainIOFTAddress]);

    // Store token addresses
    this.hubTokenAddress = hubChainToken;
    this.dstTokenAddress = this.resolveL2TokenAddress(hubChainToken);

    // Get chain-specific EID for OFT messaging
    this.dstChainEid = getOFTEidForChainId(dstChainId);

    this.hubPoolAddress = CONTRACT_ADDRESSES[hubChainId]?.hubPool?.address;

    if (!this.hubPoolAddress) {
      throw new Error(`Hub pool address not found for chain ${hubChainId}`);
    }

    // Initialize L1 contract using the hubChainIOFTAddress from the route
    this.l1Bridge = new Contract(route.hubChainIOFTAddress, IOFT_ABI_FULL, hubSigner);

    // Initialize L2 contract using the dstIOFTAddress from the route
    this.l2Bridge = new Contract(route.dstIOFTAddress, IOFT_ABI_FULL, dstSignerOrProvider);

    this.tokenDecimals = resolveToken(hubChainToken, hubChainId).decimals;
  }

  /**
   * Constructs a transaction to send tokens from L1 to L2 through the OFT bridge.
   * @param toAddress - Destination address
   * @param l1Token - Token address on L1
   * @param _l2Token - Token address on L2 (not used, determined by bridge)
   * @param amount - Amount to transfer
   * @returns Transaction details for execution
   */
  async constructL1ToL2Txn(
    toAddress: string,
    l1Token: string,
    _l2Token: string,
    amount: BigNumber
  ): Promise<BridgeTransactionDetails> {
    // Verify the token matches the one this bridge was constructed for
    if (l1Token !== this.hubTokenAddress) {
      throw new Error(`This bridge instance only supports token ${this.hubTokenAddress}, not ${l1Token}`);
    }

    // SAFETY LIMIT: Cap transfer amount to prevent large transfers
    // This is retained as a safety measure to protect against large accidental transfers
    if (amount.gt(OFTBridge.MAX_AMOUNT)) {
      throw new Error(`Amount exceeds maximum allowed (${amount} > ${OFTBridge.MAX_AMOUNT})`);
    }

    // we need to be careful what amounts we pass into OFT transfers to prevent rounding
    await this.validateAmountPrecision(amount);

    // Construct the send parameters for the OFT bridge
    // @dev last `(supportedToken.decimals() - IOFT.sharedDecimals())` digits in amount
    // must be zero to prevent rounding on the contract side
    const sendParamStruct: SendParamStruct = {
      dstEid: this.dstChainEid,
      to: oftAddressToBytes32(toAddress).toLowerCase(),
      amountLD: amount,
      minAmountLD: amount,
      extraOptions: "0x", // Empty bytes
      composeMsg: "0x", // Empty bytes
      oftCmd: "0x", // Empty bytes
    };

    // Get the messaging fee for this transfer
    const l1Bridge = this.l1Bridge;
    const feeStruct: MessagingFeeStruct = await (l1Bridge as IOFT).quoteSend(sendParamStruct, false);

    if (BigNumber.from(feeStruct.nativeFee).gt(OFTBridge.FEE_CAP)) {
      throw new Error(`Fee exceeds maximum allowed (${feeStruct.nativeFee} > ${OFTBridge.FEE_CAP})`);
    }

    // Set refund address to signer's address (used for dust refunds)
    const refundAddress = await l1Bridge.signer.getAddress();

    // Return transaction details
    return Promise.resolve({
      contract: l1Bridge,
      method: "send",
      args: [sendParamStruct, feeStruct, refundAddress],
      value: BigNumber.from(feeStruct.nativeFee),
    });
  }

  /**
   * Validates that the token amount has the correct precision for OFT transfer.
   * The last (tokenDecimals - sharedDecimals) digits must be zero to prevent rounding.
   * @param amount - Amount to validate
   * @throws Error if the amount has invalid precision
   */
  private async validateAmountPrecision(amount: BigNumber): Promise<void> {
    // Lazy-load shared decimals if not loaded yet
    if (this.sharedDecimals === undefined) {
      this.sharedDecimals = await this.l1Bridge.sharedDecimals();
    }

    // Verify the amount has the correct precision
    // The last (tokenDecimals - sharedDecimals) digits must be zero
    const decimalDifference = this.tokenDecimals - this.sharedDecimals;
    if (decimalDifference > 0) {
      const divisor = BigNumber.from(10).pow(decimalDifference);
      const remainder = amount.mod(divisor);
      if (!remainder.isZero()) {
        throw new Error(
          `Amount precision is invalid. Last ${decimalDifference} digits must be zero. ` +
            `Amount: ${amount}, Remainder: ${remainder}`
        );
      }
    }
  }

  /**
   * Queries events for token transfers initiated on the L1 chain.
   * @param l1Token - Token address on L1
   * @param fromAddress - Source address
   * @param toAddress - Destination address (not used in query, deduced from fromAddress)
   * @param eventConfig - Event search configuration
   * @returns Events grouped by token address
   */
  async queryL1BridgeInitiationEvents(
    l1Token: string,
    fromAddress: string,
    toAddress: string,
    eventConfig: EventSearchConfig
  ): Promise<BridgeEvents> {
    // Verify the token matches the one this bridge was constructed for
    if (l1Token !== this.hubTokenAddress) {
      throw new Error(`This bridge instance only supports token ${this.hubTokenAddress}, not ${l1Token}`);
    }

    const isSpokePool = await isContractDeployedToAddress(toAddress, this.l2Bridge.provider);
    if (isSpokePool && fromAddress != this.hubPoolAddress) {
      return Promise.resolve({});
    } else if (fromAddress != toAddress) {
      return Promise.resolve({});
    }

    // Get all OFTSent events for the fromAddress
    const allEvents = await paginatedEventQuery(
      this.l1Bridge,
      this.l1Bridge.filters.OFTSent(
        null, // guid - not filtering by guid (Topic[1])
        undefined, // dstEid - not an indexed parameter, should be undefined
        fromAddress // filter by `fromAddress`
      ),
      eventConfig
    );

    // Filter events by destination eid
    const events = allEvents.filter(({ args }) => args.dstEid === this.dstChainEid);

    return {
      [this.dstTokenAddress]: events.map((event) => {
        event.args.toAddress = toAddress;
        return processEvent(event, "amountReceivedLD", "toAddress", "fromAddress");
      }),
    };
  }

  /**
   * Queries events for token transfers finalized on the L2 chain.
   * @param l1Token - Token address on L1 (used for validation)
   * @param fromAddress - Source address (not used in query, deduced from toAddress)
   * @param toAddress - Destination address
   * @param eventConfig - Event search configuration
   * @returns Events grouped by token address
   */
  async queryL2BridgeFinalizationEvents(
    l1Token: string,
    fromAddress: string,
    toAddress: string,
    eventConfig: EventSearchConfig
  ): Promise<BridgeEvents> {
    // Verify the token matches the one this bridge was constructed for
    if (l1Token !== this.hubTokenAddress) {
      throw new Error(`This bridge instance only supports token ${this.hubTokenAddress}, not ${l1Token}`);
    }

    const isSpokePool = await isContractDeployedToAddress(toAddress, this.l2Bridge.provider);
    if (isSpokePool && fromAddress != this.hubPoolAddress) {
      return Promise.resolve({});
    } else if (fromAddress != toAddress) {
      return Promise.resolve({});
    }

    // Get all OFTReceived events for the toAddress
    const allEvents = await paginatedEventQuery(
      this.l2Bridge,
      this.l2Bridge.filters.OFTReceived(
        null, // guid - not filtering by guid (Topic[1])
        undefined, // srcEid - not an indexed parameter, should be undefined
        toAddress // filter by `toAddress`
      ),
      eventConfig
    );

    // Filter events by source eid
    const sourceEid = getOFTEidForChainId(this.hubChainId);
    const events = allEvents.filter((event) => event.args.srcEid === sourceEid);

    return {
      [this.dstTokenAddress]: events.map((event) => {
        event.args.fromAddress = fromAddress;
        return processEvent(event, "amountReceivedLD", "toAddress", "fromAddress");
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
  return ethers.utils.hexZeroPad(address, 32);
}
