import {
  Contract,
  BigNumber,
  paginatedEventQuery,
  EventSearchConfig,
  Signer,
  Provider,
  isContractDeployedToAddress,
  EvmAddress,
} from "../../utils";
import { CONTRACT_ADDRESSES } from "../../common";
import { BaseBridgeAdapter, BridgeTransactionDetails, BridgeEvents } from "./BaseBridgeAdapter";
import { processEvent } from "../utils";

export class SnxOptimismBridge extends BaseBridgeAdapter {
  constructor(l2chainId: number, hubChainId: number, l1Signer: Signer, l2SignerOrProvider: Signer | Provider) {
    super(l2chainId, hubChainId, l1Signer, l2SignerOrProvider, [
      EvmAddress.from(CONTRACT_ADDRESSES[hubChainId].snxOptimismBridge.address),
    ]);

    const { address: l1Address, abi: l1Abi } = CONTRACT_ADDRESSES[hubChainId].snxOptimismBridge;
    this.l1Bridge = new Contract(l1Address, l1Abi, l1Signer);

    const { address: l2Address, abi: l2Abi } = CONTRACT_ADDRESSES[l2chainId].snxOptimismBridge;
    this.l2Bridge = new Contract(l2Address, l2Abi, l2SignerOrProvider);
  }

  async constructL1ToL2Txn(
    toAddress: EvmAddress,
    l1Token: EvmAddress,
    l2Token: EvmAddress,
    amount: BigNumber
  ): Promise<BridgeTransactionDetails> {
    return Promise.resolve({
      contract: this.getL1Bridge(),
      method: "depositTo",
      args: [toAddress.toAddress(), amount],
    });
  }

  async queryL1BridgeInitiationEvents(
    l1Token: EvmAddress,
    fromAddress: EvmAddress,
    toAddress: EvmAddress,
    eventConfig: EventSearchConfig
  ): Promise<BridgeEvents> {
    const hubPoolAddress = EvmAddress.from(this.getHubPool().address);
    // @dev Since the SnxOptimism bridge has no _from field when querying for finalizations, we cannot use
    // the hub pool to determine cross chain transfers (since we do not assume knowledge of the spoke pool address).
    if (fromAddress.eq(hubPoolAddress)) {
      return Promise.resolve({});
    }
    // If `toAddress` is a contract on L2, then assume the contract is the spoke pool, and further assume that the sender
    // is the hub pool.
    const isSpokePool = await this.isL2ChainContract(toAddress);
    fromAddress = isSpokePool ? hubPoolAddress : fromAddress;
    const events = await paginatedEventQuery(
      this.getL1Bridge(),
      this.getL1Bridge().filters.DepositInitiated(fromAddress.toAddress()),
      eventConfig
    );
    return {
      [this.resolveL2TokenAddress(l1Token)]: events.map((event) => processEvent(event, "_amount")),
    };
  }

  async queryL2BridgeFinalizationEvents(
    l1Token: EvmAddress,
    fromAddress: EvmAddress,
    toAddress: EvmAddress,
    eventConfig: EventSearchConfig
  ): Promise<BridgeEvents> {
    const events = await paginatedEventQuery(
      this.getL2Bridge(),
      this.getL2Bridge().filters.DepositFinalized(toAddress.toAddress()),
      eventConfig
    );
    return {
      [this.resolveL2TokenAddress(l1Token)]: events.map((event) => processEvent(event, "_amount")),
    };
  }

  private getHubPool(): Contract {
    const hubPoolContractData = CONTRACT_ADDRESSES[this.hubChainId]?.hubPool;
    if (!hubPoolContractData) {
      throw new Error(`hubPoolContractData not found for chain ${this.hubChainId}`);
    }
    return new Contract(hubPoolContractData.address, hubPoolContractData.abi, this.l1Signer);
  }

  private isL2ChainContract(address: EvmAddress): Promise<boolean> {
    return isContractDeployedToAddress(address.toAddress(), this.getL2Bridge().provider);
  }
}
