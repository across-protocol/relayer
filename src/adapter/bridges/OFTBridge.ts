import { Contract, ethers, Signer } from "ethers";
import { BridgeTransactionDetails, BaseBridgeAdapter, BridgeEvents } from "./BaseBridgeAdapter";
import {
  BigNumber,
  EventSearchConfig,
  Provider,
  TOKEN_SYMBOLS_MAP,
  assert,
  isDefined,
  paginatedEventQuery,
  // ERC20,
} from "../../utils";
import { processEvent } from "../utils";
import { CHAIN_IDs, PUBLIC_NETWORKS } from "@across-protocol/constants";

import { IOFT__factory } from "@across-protocol/contracts";

import {
  IOFT,
  MessagingFeeStruct,
  SendParamStruct,
} from "@across-protocol/contracts/typechain/@layerzerolabs/oft-evm/contracts/interfaces/IOFT";

export type OFTBridgeEdge = {
  l2ChainId: number;
  srcIOFTAddress: string;
  dstIOFTAddress: string;
};

export class OFTBridge extends BaseBridgeAdapter {
  // todo: should this one go to a "constants" repo? Actually, it feels nice to have it confined within the OFT files cause it's strictly OFT-related
  // Define supported OFT transfer paths with contract addresses
  // Structure: { tokenAddress: OFTBridgeEdge[] }
  private static readonly SUPPORTED_OFT_PATHS: {
    [tokenAddress: string]: OFTBridgeEdge[];
  } = {
    // USDT supports transfers from Ethereum to Arbitrum
    [TOKEN_SYMBOLS_MAP.USDT.addresses[CHAIN_IDs.MAINNET]]: [
      {
        // todo: should I enforce key uniqueness here? I feel like it's fine
        l2ChainId: CHAIN_IDs.ARBITRUM,
        srcIOFTAddress: "0x6C96dE32CEa08842dcc4058c14d3aaAD7Fa41dee",
        dstIOFTAddress: "0x14E4A1B13bf7F943c8ff7C51fb60FA964A298D92",
      },
    ],
  };

  // Map to store IOFT contract ethers entities per token per chain
  private oftContracts: {
    [l1TokenAddress: string]: {
      [chainId: number]: {
        address: string;
        // todo: make this an IOFT contract type?
        contract: Contract;
      };
    };
  } = {};

  /**
   * Adds an OFT contract to the internal map
   * @param tokenAddress The token address
   * @param chainId The chain ID
   * @param contractAddress The OFT contract address
   * @param signerOrProvider The signer or provider to use for the contract
   */
  private addOftContract(
    tokenAddress: string,
    chainId: number,
    contractAddress: string,
    signerOrProvider: Signer | Provider
  ): void {
    this.oftContracts[tokenAddress] ??= {};

    this.oftContracts[tokenAddress][chainId] = {
      address: contractAddress,
      contract: new Contract(contractAddress, IOFT__factory.abi, signerOrProvider),
    };
  }

  constructor(l2chainId: number, hubChainId: number, l1Signer: Signer, l2SignerOrProvider: Signer | Provider) {
    super(l2chainId, hubChainId, l1Signer, l2SignerOrProvider, [
      // todo: don't want to approve all OFT contracts for large amounts. I think we should instead do approvals before we're doing cross-chain transfers
    ]);

    // Iterate over all supported tokens and paths
    Object.entries(OFTBridge.SUPPORTED_OFT_PATHS).forEach(([l1TokenAddress, edges]) => {
      // For each token, find the edge that matches our destination chain
      const edge = edges.find((edge) => edge.l2ChainId === l2chainId);

      if (edge) {
        // Get the corresponding L2 token address
        const l2TokenAddress = this.resolveL2TokenAddress(l1TokenAddress);

        // Initialize L1 contract using the srcIOFTAddress from the edge
        this.addOftContract(l1TokenAddress, hubChainId, edge.srcIOFTAddress, l1Signer);

        // Initialize L2 contract using the dstIOFTAddress from the edge
        this.addOftContract(l2TokenAddress, l2chainId, edge.dstIOFTAddress, l2SignerOrProvider);
      }
    });
  }

  private get l2DestinationEId(): number {
    return getOFTEIdForChainId(this.l2chainId);
  }

  /**
   * This function is not supported. Inherited from BaseBridgeAdapter
   */
  protected getL1Bridge(): Contract {
    throw new Error("Not supported for OFTBridge because we have multiple L1Bridge contracts");
  }

  /**
   * Gets the L1 bridge contract for the specified token
   * @param l1Token The L1 token address
   * @returns The L1 bridge contract
   */
  protected getL1BridgeForToken(l1Token: string): Contract {
    const l1Contract = this.oftContracts[l1Token]?.[this.hubChainId]?.contract;

    assert(isDefined(l1Contract), `Cannot access L1 Bridge for token ${l1Token} when it is undefined.`);
    return l1Contract;
  }

  /**
   * This function is not supported. Inherited from BaseBridgeAdapter
   */
  protected getL2Bridge(): Contract {
    throw new Error("Not supported for OFTBridge because we have multiple L2Bridge contracts");
  }

  /**
   * Gets the L2 bridge contract for the specified token
   * @param l1Token The L1 token address
   * @returns The L2 bridge contract
   */
  protected getL2BridgeForL1Token(l1Token: string): Contract {
    const l2TokenAddress = this.resolveL2TokenAddress(l1Token);
    const l2Contract = this.oftContracts[l2TokenAddress]?.[this.l2chainId]?.contract;

    assert(isDefined(l2Contract), `Cannot access L2 Bridge for token ${l2TokenAddress} when it is undefined.`);
    return l2Contract;
  }

  // ! todo: check this ⚠️
  async constructL1ToL2Txn(
    toAddress: string,
    l1Token: string,
    _l2Token: string,
    amount: BigNumber
  ): Promise<BridgeTransactionDetails> {
    // Verify the token is supported
    assert(
      OFTBridge.SUPPORTED_OFT_PATHS[l1Token]?.some((edge) => edge.l2ChainId === this.l2chainId),
      `Token ${l1Token} is not supported for transfer from chain ${this.hubChainId} to ${this.l2chainId}`
    );

    // With `amount` here, we have to be mindful of `_removeDust` logic in `OFTCore` code
    // TLDR: last `(supportedToken.decimals() - IOFT.sharedDecimals())` digits in amount have to be set to 0 to prevent rounding on the contract side
    // more details here https://github.com/LayerZero-Labs/devtools/blob/a843edfc160f3cfa35d952b616b1cfe462503bc0/packages/oft-evm/contracts/OFTCore.sol#L343

    const sendParamStruct: SendParamStruct = {
      dstEid: this.l2DestinationEId,
      to: oftAddressToBytes32(toAddress).toLowerCase(), // todo: .toLowerCase just in case, check this
      amountLD: amount,
      minAmountLD: amount,
      extraOptions: "0x", // todo: 0x -- is this the way to do it?
      composeMsg: "0x",
      oftCmd: "0x",
    };

    // Get the L1 bridge contract for this token
    const l1Bridge = this.getL1BridgeForToken(l1Token);

    // todo: will this work?
    const feeStruct: MessagingFeeStruct = await (l1Bridge as IOFT).quoteSend(sendParamStruct, false);

    console.log("ethFee: ", feeStruct.nativeFee.toString());

    // mult fee by 2 in order to get our tx included with high probability. Excess fee will get refunded
    const ethFee = feeStruct[0].mul(2);

    const newFeeStruct: MessagingFeeStruct = {
      nativeFee: ethFee,
      lzTokenFee: "0",
    };

    // ! note : if (msg.value != _nativeFee) revert NotEnoughNative(msg.value);
    // ! nativeFee value has to be EXACTLY the msg.value

    console.log("ethFee: ", ethFee.toString());

    const cap = ethers.utils.parseEther("0.01");

    if (ethFee.gt(cap)) {
      throw `can't go over fee cap (${ethFee} > ${cap})`;
    } else {
      console.log("feeCap: ", cap.toString());
      console.log("fee is okay.");
    }

    const refundAddress = await l1Bridge.signer.getAddress();

    const amountCap = ethers.utils.parseUnits("1.0", 6);
    if (amount.gt(amountCap)) {
      throw "can't go over amount cap";
    } else {
      console.log("amountCap: ", amountCap.toString());
      console.log("amount is okay.");
    }

    console.log("amount: ", amount.toString());

    // tx details for `OAdapterUpgradeable.send(..)`
    return Promise.resolve({
      contract: l1Bridge,
      method: "send",
      args: [sendParamStruct, newFeeStruct, refundAddress],
      value: ethFee,
    });
  }

  // todo: right now, we're creating all the initiations creted by `fromAddress`, not filtering by `toAddress`, because OFT doesn't tell us that.
  // todo: this could lead to duplicate events somewhere in the code -- check for how it's handled
  //
  // todo: `PacketSent` event is also emitted, which can potentially contain receiver info. It'd be cumbersome to also get that
  async queryL1BridgeInitiationEvents(
    l1Token: string,
    fromAddress: string,
    toAddress: string,
    eventConfig: EventSearchConfig
  ): Promise<BridgeEvents> {
    const l1Bridge = this.getL1BridgeForToken(l1Token);

    // Get all OFTSent events for the fromAddress
    const allEvents = await paginatedEventQuery(
      l1Bridge,
      l1Bridge.filters.OFTSent(
        null, // guid - not filtering by guid (Topic[1])
        undefined, // dstEid - not an indexed parameter, should be undefined
        fromAddress // filter by `fromAddress`
      ),
      eventConfig
    );

    // Filter events by destination EID since it's not an indexed parameter
    // and can't be filtered directly in the query
    const destinationEId = this.l2DestinationEId;
    // The dstEid is the first parameter in the OFTSent event
    const events = allEvents.filter(({ args }) => args.dstEid === destinationEId);

    return {
      [this.resolveL2TokenAddress(l1Token)]: events.map((event) =>
        /**
         * todo:
         * Returning an empty `to` in my event. Is that bad? Check how output is used
         *
         * export type BridgeEvent = SortableEvent & {
         *    to: string;
         *    from: string;
         *    amount: BigNumber;
         *  };
         */
        processEvent(event, "amountReceivedLD", "", "fromAddress")
      ),
    };
  }

  async queryL2BridgeFinalizationEvents(
    l1Token: string,
    fromAddress: string,
    toAddress: string,
    eventConfig: EventSearchConfig
  ): Promise<BridgeEvents> {
    const l2Bridge = this.getL2BridgeForL1Token(l1Token);

    // Get all OFTReceived events for the toAddress
    const allEvents = await paginatedEventQuery(
      l2Bridge,
      l2Bridge.filters.OFTReceived(
        null, // guid - not filtering by guid (Topic[1])
        undefined, // srcEid - not an indexed parameter, should be undefined
        toAddress // filter by `toAddress`
      ),
      eventConfig
    );

    // Filter events by source EID since it's not an indexed parameter
    // and can't be filtered directly in the query
    const sourceEId = getOFTEIdForChainId(this.hubChainId);
    const events = allEvents.filter((event) => {
      // The srcEid is the first parameter in the OFTReceived event
      return event.args.srcEid === sourceEId;
    });

    return {
      /**
       * todo:
       * Returning an empty `from` in my event. Is that bad? Check how output is used
       *
       * export type BridgeEvent = SortableEvent & {
       *    to: string;
       *    from: string;
       *    amount: BigNumber;
       *  };
       */
      [this.resolveL2TokenAddress(l1Token)]: events.map((event) =>
        processEvent(event, "amountReceivedLD", "toAddress", "")
      ),
    };
  }
}

/**
 * Retrieves the OFT EID for a given chainId.
 * @param chainId The chainId to get the OFT EID for.
 * @returns The OFT EID for the given chainId.
 */
export function getOFTEIdForChainId(chainId: number): number {
  const eId = PUBLIC_NETWORKS[chainId].oftEId;
  if (!isDefined(eId)) {
    throw new Error(`No OFT domain found for chainId: ${chainId}`);
  }
  return eId;
}

// checked ✅
/**
 * Converts an Ethereum address to bytes32 format for OFT bridge. Zero-pads from the left
 * @param address The Ethereum address to convert.
 * @returns The bytes32 representation of the address.
 */
export function oftAddressToBytes32(address: string): string {
  return ethers.utils.hexZeroPad(address, 32);
}
