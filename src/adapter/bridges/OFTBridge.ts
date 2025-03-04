import { Contract, ethers, Signer } from "ethers";
import { CONTRACT_ADDRESSES } from "../../common";
import { BridgeTransactionDetails, BaseBridgeAdapter, BridgeEvents } from "./BaseBridgeAdapter";
import {
  BigNumber,
  EventSearchConfig,
  Provider,
  TOKEN_SYMBOLS_MAP,
  compareAddressesSimple,
  assert,
  toBN,
  isDefined,
  paginatedEventQuery,
} from "../../utils";
import { processEvent } from "../utils";
import { PUBLIC_NETWORKS } from "@across-protocol/constants";

export class OFTBridge extends BaseBridgeAdapter {
  // for now, the only supported token is USDT, so this works. If we are to support more tokens, this will need to change
  private MAX_SEND_AMOUNT_USDT = toBN(1_000_000_000_000); // 1MM USDT.

  constructor(l2chainId: number, hubChainId: number, l1Signer: Signer, l2SignerOrProvider: Signer | Provider) {
    super(l2chainId, hubChainId, l1Signer, l2SignerOrProvider, [
      // there's a single contract on mainnet for USDT integraion
      // if we're to add more assets in the future, we'd have to pass in an array here
      CONTRACT_ADDRESSES[hubChainId].oftMessengerUSDT.address,
    ]);

    // `l1Address` and `l1Abi` are for the contract called `OAdapterUpgradeable` and interface `IOFT` respectively.
    // These addresses for `USDT0` can be viewed here https://docs.usdt0.to/technical-documentation/developer#id-3.-deployments
    const { address: l1Address, abi: l1Abi } = CONTRACT_ADDRESSES[hubChainId].oftMessengerUSDT;
    this.l1Bridge = new Contract(l1Address, l1Abi, l1Signer);

    // similar to above, but address is for `OUpgradeable`
    const { address: l2Address, abi: l2Abi } = CONTRACT_ADDRESSES[l2chainId].oftMessengerUSDT;
    this.l2Bridge = new Contract(l2Address, l2Abi, l2SignerOrProvider);
  }

  private get l2DestinationEId(): number {
    return getOFTEIdForChainId(this.l2chainId);
  }

  private get l1UsdtTokenAddress(): string {
    return TOKEN_SYMBOLS_MAP.USDT.addresses[this.hubChainId];
  }

  protected resolveL2TokenAddress(l1Token: string): string {
    l1Token;
    return TOKEN_SYMBOLS_MAP.USDT.addresses[this.l2chainId];
  }

  async constructL1ToL2Txn(
    toAddress: string,
    _l1Token: string,
    _l2Token: string,
    amount: BigNumber
  ): Promise<BridgeTransactionDetails> {
    assert(compareAddressesSimple(_l1Token, TOKEN_SYMBOLS_MAP.USDT.addresses[this.hubChainId]));
    // With `amount` here, we have to be mindful of `_removeDust` logic in `OFTCore` code
    // TLDR: last `(supportedToken.decimals() - IOFT.sharedDecimals())` digits in amount have to be set to 0 to prevent rounding on the contract side
    // more details here https://github.com/LayerZero-Labs/devtools/blob/a843edfc160f3cfa35d952b616b1cfe462503bc0/packages/oft-evm/contracts/OFTCore.sol#L343
    amount = amount.gt(this.MAX_SEND_AMOUNT_USDT) ? this.MAX_SEND_AMOUNT_USDT : amount;

    return Promise.resolve({
      contract: this.getL1Bridge(),
      method: "send", // Name of the method called on a `OAdapterUpdgradeable` contract
      /*
      todo ihor:
        these are the params I should be passing into the send method on the contract side as if I were sending a send to the contract directly.
        Should experiment with a dev wallet with how to construct these args. Currently, totally wrong
        I should be using something like this to construct my message (bring typechain from contracts repo): `export { ERC20__factory } from "@across-protocol/contracts/dist/typechain/factories/@openzeppelin/contracts/token/ERC20/ERC20__factory";`
      */
      args: [amount, this.l2DestinationEId, oftAddressToBytes32(toAddress), this.l1UsdtTokenAddress],
    });
  }

  // checked: OK!
  async queryL1BridgeInitiationEvents(
    l1Token: string,
    fromAddress: string,
    toAddress: string,
    eventConfig: EventSearchConfig
  ): Promise<BridgeEvents> {
    const l1Bridge = this.getL1Bridge();
    // todo: just query `OFTSent` events like in the test project => call processEvent on each => return
    const events = await paginatedEventQuery(
      l1Bridge,
      l1Bridge.filters.OFTSent(
        null, // guid - not filtering by guid (Topic[1])
        undefined, // dstEid - not an indexed parameter, should be undefined
        fromAddress // filter by `fromAddress`
      ),
      eventConfig
    );

    return {
      [this.resolveL2TokenAddress(l1Token)]: events.map((event) =>
        /*
        todo ihor:
        `processEvent` args are: `event: Log, amountField: string, toField: string, fromField: string`
          there's no `to` field in my log
        todo ihor:
          see how the result of this is used. We can fitler by `dstEId` here
          theoretically, we could create a global map called ADDRESS_TO_DST_EID, and filter by dstEId in this way, but that's awful
        */
        processEvent(event, "amountReceivedLD", "", "fromAddress")
      ),
    };
  }

  // checked: OK!
  async queryL2BridgeFinalizationEvents(
    l1Token: string,
    fromAddress: string,
    toAddress: string,
    eventConfig: EventSearchConfig
  ): Promise<BridgeEvents> {
    const l2Bridge = this.l2Bridge;
    const events = await paginatedEventQuery(
      l2Bridge,
      l2Bridge.filters.OFTReceived(
        null, // guid - not filtering by guid (Topic[1])
        undefined, // srcEid - not an indexed parameter, should be undefined
        toAddress // filter by `toAddress`
      ),
      eventConfig
    );
    return {
      /*
      ihor todo: same in `queryL1BridgeInitiationEvents`: there's no `fromAddress` here
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
  const eId = PUBLIC_NETWORKS[chainId]?.oftEId;
  if (!isDefined(eId)) {
    throw new Error(`No OFT domain found for chainId: ${chainId}`);
  }
  return eId;
}

// checked: OK!
/**
 * Converts an Ethereum address to bytes32 format for OFT bridge. Zero-pads from the left
 * @param address The Ethereum address to convert.
 * @returns The bytes32 representation of the address.
 */
export function oftAddressToBytes32(address: string): string {
  return ethers.utils.hexZeroPad(address, 32);
}
