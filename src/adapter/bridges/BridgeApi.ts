import { Contract, Signer } from "ethers";
import { BridgeTransactionDetails, BaseBridgeAdapter, BridgeEvents } from "./BaseBridgeAdapter";
import {
  BigNumber,
  EventSearchConfig,
  Provider,
  assert,
  Address,
  EvmAddress,
  winston,
  toBN,
  getNetworkName,
  CHAIN_IDs,
} from "../../utils";
import { TransferTokenParams } from "../utils";
import ERC20_ABI from "../../common/abi/MinimalERC20.json";

export const BRIDGE_API_MINIMUMS: { [l2ChainId: number]: BigNumber } = {
  [CHAIN_IDs.MAINNET]: toBN(1_000_000), // 1 USDC
  [CHAIN_IDs.TEMPO]: toBN(1_000_000), // 1 USDC
};

export class BridgeApi extends BaseBridgeAdapter {
  constructor(
    l2chainId: number,
    hubChainId: number,
    l1Signer: Signer,
    l2SignerOrProvider: Signer | Provider,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    l1Token: EvmAddress,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _logger: winston.Logger
  ) {
    // Bridge API is only valid on mainnet.
    assert(hubChainId === CHAIN_IDs.MAINNET);

    super(l2chainId, hubChainId, l1Signer, []);
    this.l1Bridge = new Contract(l1Token.toNative(), ERC20_ABI, l1Signer);
  }

  async constructL1ToL2Txn(
    toAddress: Address,
    l1Token: EvmAddress,
    _l2Token: Address,
    amount: BigNumber,
    _optionalParams?: TransferTokenParams
  ): Promise<BridgeTransactionDetails> {
    // If amount is less than the network minimums, then throw.
    if (amount.lt(BRIDGE_API_MINIMUMS[this.l2chainId])) {
      throw new Error(`Cannot bridge to ${getNetworkName(this.l2chainId)} due to invalid amount ${amount}`);
    }
    // Get the transfer route source address.
    const transferRouteSource = await this.l1Signer.getAddress();
    return Promise.resolve({
      contract: this.getL1Bridge(),
      method: "transfer",
      args: [transferRouteSource, amount],
    });
  }

  async queryL1BridgeInitiationEvents(
    _l1Token: EvmAddress,
    _fromAddress: EvmAddress,
    _toAddress: Address,
    _eventConfig: EventSearchConfig
  ): Promise<BridgeEvents> {
    return Promise.resolve({});
  }

  async queryL2BridgeFinalizationEvents(
    _l1Token: EvmAddress,
    _fromAddress: EvmAddress,
    _toAddress: Address,
    _eventConfig: EventSearchConfig
  ): Promise<BridgeEvents> {
    return Promise.resolve({});
  }
}
