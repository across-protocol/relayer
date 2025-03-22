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
} from "../../utils";
import { processEvent } from "../utils";
import { CHAIN_IDs, PUBLIC_NETWORKS } from "@across-protocol/constants";

import { IOFT__factory } from "@across-protocol/contracts";

import {
  IOFT,
  MessagingFeeStruct,
  SendParamStruct,
} from "@across-protocol/contracts/typechain/contracts/interfaces/IOFT";

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

  private hubTokenAddress: string;
  private dstTokenAddress: string;

  // todo: changed naming in constructor. Should be fine
  constructor(
    dstChainId: number,
    hubChainId: number,
    hubSigner: Signer,
    dstSignerOrProvider: Signer | Provider,
    hubChainToken: string
  ) {
    if (hubChainId != 1) {
      // OFT_ROUTES map supports only Ethereum -> dstChain routes
      throw "Unexpected hub chain.";
    }

    // Check if the route exists for this token and chain
    const route = OFTBridge.SUPPORTED_ROUTES[hubChainToken]?.[dstChainId];
    assert(isDefined(route), `No route found for token ${hubChainToken} from chain ${hubChainId} to ${dstChainId}`);

    // todo: how are l1Gateways used in super?
    super(dstChainId, hubChainId, hubSigner, dstSignerOrProvider, [route.hubChainIOFTAddress]);

    this.hubTokenAddress = hubChainToken;
    this.dstTokenAddress = this.resolveL2TokenAddress(hubChainToken);

    // Initialize L1 contract using the srcIOFTAddress from the route
    this.l1Bridge = new Contract(route.hubChainIOFTAddress, IOFT__factory.abi, hubSigner);

    // Initialize L2 contract using the dstIOFTAddress from the route
    this.l2Bridge = new Contract(route.dstIOFTAddress, IOFT__factory.abi, dstSignerOrProvider);
  }

  // todo: this works for ad-hoc sending. Will this work in full relayer flow?
  async constructL1ToL2Txn(
    toAddress: string,
    l1Token: string,
    _l2Token: string,
    amount: BigNumber
  ): Promise<BridgeTransactionDetails> {
    // Verify the token matches the one this bridge was constructed for
    assert(
      l1Token === this.hubTokenAddress,
      `This bridge instance only supports token ${this.hubTokenAddress}, not ${l1Token}`
    );

    // With `amount` here, we have to be mindful of `_removeDust` logic in `OFTCore` code
    // TLDR: last `(supportedToken.decimals() - IOFT.sharedDecimals())` digits in amount have to be set to 0 to prevent rounding on the contract side
    // more details here https://github.com/LayerZero-Labs/devtools/blob/a843edfc160f3cfa35d952b616b1cfe462503bc0/packages/oft-evm/contracts/OFTCore.sol#L343

    const sendParamStruct: SendParamStruct = {
      dstEid: this.dstChainEid,
      to: oftAddressToBytes32(toAddress).toLowerCase(),
      amountLD: amount,
      minAmountLD: amount,
      extraOptions: "0x", // 0x for empty bytes
      composeMsg: "0x",
      oftCmd: "0x",
    };

    // Get the L1 bridge contract
    const l1Bridge = this.l1Bridge;

    const feeStruct: MessagingFeeStruct = await (l1Bridge as IOFT).quoteSend(sendParamStruct, false);

    // ! note : if (msg.value != _nativeFee) revert NotEnoughNative(msg.value);
    // ! nativeFee value has to be EXACTLY the msg.value
    this.logMessage("ethFee", { ethFee: feeStruct.nativeFee.toString() });

    const cap = ethers.utils.parseEther("0.01");

    if (BigNumber.from(feeStruct.nativeFee).gt(cap)) {
      throw `can't go over fee cap (${feeStruct.nativeFee} > ${cap})`;
    } else {
      this.logMessage("feeCap check", { feeCap: cap.toString(), message: "fee is okay" });
    }

    // not to self: `refundAddress` is used to return the diff from dustSubtraction, not for nativeFee.
    // Theoretically can leave this at zero, but we set to signer addr just in case
    const refundAddress = await l1Bridge.signer.getAddress();

    // todo: test code
    const amountCap = ethers.utils.parseUnits("1.0", 6);
    if (amount.gt(amountCap)) {
      throw "can't go over amount cap";
    } else {
      this.logMessage("amountCap check", { amountCap: amountCap.toString(), message: "amount is okay" });
    }

    this.logMessage("amount", { amount: amount.toString() });

    // tx details for `OAdapterUpgradeable.send(..)`
    return Promise.resolve({
      contract: l1Bridge,
      method: "send",
      args: [sendParamStruct, feeStruct, refundAddress],
      value: BigNumber.from(feeStruct.nativeFee),
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
    // Verify the token matches the one this bridge was constructed for
    assert(
      l1Token === this.hubTokenAddress,
      `This bridge instance only supports token ${this.hubTokenAddress}, not ${l1Token}`
    );

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
      [this.dstTokenAddress]: events.map((event) =>
        /**
         * todo:
         * Returning an empty `to` in my event. Is that bad? Check how output is used.
         * To set this field, we could request all tx hashes from Logs that we found,
         * and then decode inputs to txs to decide the `tx.to`. It's non-trivial. Do
         * we need that?
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
    // Verify the token matches the one this bridge was constructed for
    assert(
      l1Token === this.hubTokenAddress,
      `This bridge instance only supports token ${this.hubTokenAddress}, not ${l1Token}`
    );

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

    // Filter events by source eid since it's not an indexed parameter
    // and can't be filtered directly in the query
    const sourceEid = getOFTEidForChainId(this.hubChainId);
    const events = allEvents.filter((event) => {
      // The srcEid is the first parameter in the OFTReceived event
      return event.args.srcEid === sourceEid;
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
      [this.dstTokenAddress]: events.map((event) => processEvent(event, "amountReceivedLD", "toAddress", "")),
    };
  }

  private get dstChainEid(): number {
    return getOFTEidForChainId(this.l2chainId);
  }

  // todo: remove once we're done testing
  private logMessage(...args: any[]): void {
    // eslint-disable-next-line no-console
    console.log(...args);
  }
}

/**
 * Retrieves the OFT EID for a given chainId.
 * @param chainId The chainId to get the OFT EID for.
 * @returns The OFT EID for the given chainId.
 */
export function getOFTEidForChainId(chainId: number): number {
  const eid = PUBLIC_NETWORKS[chainId].oftEid;
  if (!isDefined(eid)) {
    throw new Error(`No OFT domain found for chainId: ${chainId}`);
  }
  return eid;
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
