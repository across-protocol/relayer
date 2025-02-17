import {
  Contract,
  BigNumber,
  EventSearchConfig,
  paginatedEventQuery,
  Signer,
  Provider,
  ZERO_ADDRESS,
  bnZero,
  TOKEN_SYMBOLS_MAP,
} from "../../utils";
import { CONTRACT_ADDRESSES } from "../../common";
import { Log } from "../../interfaces";
import { matchL2EthDepositAndWrapEvents, processEvent } from "../utils";
import { utils } from "@across-protocol/sdk";
import { BridgeTransactionDetails, BaseBridgeAdapter, BridgeEvents } from "./BaseBridgeAdapter";
import WETH_ABI from "../../common/abi/Weth.json";

export class OpStackWethBridge extends BaseBridgeAdapter {
  protected atomicDepositor: Contract;
  protected l2Weth: Contract;
  private readonly hubPoolAddress: string;

  private readonly l2Gas = 200000;

  constructor(
    l2chainId: number,
    hubChainId: number,
    l1Signer: Signer,
    l2SignerOrProvider: Signer | Provider,
    _l1Token: string
  ) {
    // Lint Appeasement
    _l1Token;
    super(
      l2chainId,
      hubChainId,
      l1Signer,
      l2SignerOrProvider,
      // To keep existing logic, we should use atomic depositor as the l1 bridge
      [CONTRACT_ADDRESSES[hubChainId].atomicDepositor.address]
    );

    const { address: l1Address, abi: l1Abi } = CONTRACT_ADDRESSES[hubChainId][`ovmStandardBridge_${l2chainId}`];
    this.l1Bridge = new Contract(l1Address, l1Abi, l1Signer);

    const { address: l2Address, abi: l2Abi } = CONTRACT_ADDRESSES[l2chainId].ovmStandardBridge;
    this.l2Bridge = new Contract(l2Address, l2Abi, l2SignerOrProvider);

    const { address: atomicDepositorAddress, abi: atomicDepositorAbi } = CONTRACT_ADDRESSES[hubChainId].atomicDepositor;
    this.atomicDepositor = new Contract(atomicDepositorAddress, atomicDepositorAbi, l1Signer);

    this.l2Weth = new Contract(TOKEN_SYMBOLS_MAP.WETH.addresses[l2chainId], WETH_ABI, l2SignerOrProvider);
    this.hubPoolAddress = CONTRACT_ADDRESSES[this.hubChainId]?.hubPool?.address;
  }

  async constructL1ToL2Txn(
    toAddress: string,
    l1Token: string,
    l2Token: string,
    amount: BigNumber
  ): Promise<BridgeTransactionDetails> {
    const bridgeCalldata = this.getL1Bridge().interface.encodeFunctionData("depositETHTo", [
      toAddress,
      this.l2Gas,
      "0x",
    ]);
    return Promise.resolve({
      contract: this.atomicDepositor,
      method: "bridgeWeth",
      args: [this.l2chainId, amount, amount, bnZero, bridgeCalldata],
    });
  }

  private convertEventListToBridgeEvents(events: Log[]): BridgeEvents {
    return {
      [this.resolveL2TokenAddress(TOKEN_SYMBOLS_MAP.WETH.addresses[this.hubChainId])]: events.map((event) =>
        processEvent(event, "_amount", "_to", "_from")
      ),
    };
  }

  async queryL1BridgeInitiationEvents(
    l1Token: string,
    fromAddress: string,
    toAddress: string,
    eventConfig: EventSearchConfig
  ): Promise<BridgeEvents> {
    // We need to be smart about the filtering here because the ETHDepositInitiated event does not
    // index on the `toAddress` which is the `fromAddress` that we pass in here and the address we want
    // to actually filter on. So we make some simplifying assumptions:
    // - For our tracking purposes, the ETHDepositInitiated `fromAddress` will be the
    //   AtomicDepositor if the fromAddress is an EOA.
    const isContract = await this.isHubChainContract(fromAddress);
    const isL2ChainContract = await this.isL2ChainContract(fromAddress);

    // Since we can only index on the `fromAddress` for the ETHDepositInitiated event, we can't support
    // monitoring the spoke pool address
    if (isL2ChainContract || (isContract && fromAddress !== this.hubPoolAddress)) {
      return this.convertEventListToBridgeEvents([]);
    }

    const events = await paginatedEventQuery(
      this.getL1Bridge(),
      this.getL1Bridge().filters.ETHDepositInitiated(isContract ? fromAddress : this.atomicDepositor.address),
      eventConfig
    );
    // If EOA sent the ETH via the AtomicDepositor, then remove any events where the
    // toAddress is not the EOA so we don't get confused with other users using the AtomicDepositor
    if (!isContract) {
      return this.convertEventListToBridgeEvents(events.filter((event) => event.args._to === fromAddress));
    }
    return this.convertEventListToBridgeEvents(events);
  }

  async queryL2BridgeFinalizationEvents(
    l1Token: string,
    fromAddress: string,
    toAddress: string,
    eventConfig: EventSearchConfig
  ): Promise<BridgeEvents> {
    // Check if the sender is a contract on the L1 network.
    const isContract = await this.isHubChainContract(fromAddress);

    // See above for why we don't want to monitor the spoke pool contract.
    const isL2ChainContract = await this.isL2ChainContract(fromAddress);
    if (isL2ChainContract || (isContract && fromAddress !== this.hubPoolAddress)) {
      return this.convertEventListToBridgeEvents([]);
    }

    if (!isContract) {
      // When bridging WETH to OP stack chains from an EOA, ETH is bridged via the AtomicDepositor contract
      // and received as ETH on L2. The InventoryClient is built to abstract this subtlety and
      // assumes that WETH is being rebalanced from L1 to L2. Therefore, L1 to L2 ETH transfers sent from an EOA
      // should only be considered finalized if they are followed by an L2 Wrapped Ether "Deposit" event,
      // signifying that the relayer has received WETH into their inventory.
      const l2EthDepositEvents = (
        await paginatedEventQuery(
          this.getL2Bridge(),
          this.getL2Bridge().filters.DepositFinalized(ZERO_ADDRESS, undefined, this.atomicDepositor.address),
          eventConfig
        )
      )
        // If EOA sent the ETH via the AtomicDepositor, then remove any events where the
        // toAddress is not the EOA so we don't get confused with other users using the AtomicDepositor
        .filter((event) => event.args._to === toAddress);

      // We only care about WETH finalization events initiated by the relayer running this rebalancer logic, so only
      // filter on Deposit events sent from the provided signer. We can't simply filter on `fromAddress` because
      // this would require that the AtomicWethDepositor address wrapped the ETH into WETH, which is not the case for
      // ETH transfers initiated by the AtomicWethDepositor. ETH is sent from the AtomicWethDepositor contract
      // on L1 and received as ETH on L2 by the recipient, which is finally wrapped into WETH on the L2 by the
      // recipient--the L2 signer in this class.
      const l2EthWrapEvents = await this.queryL2WrapEthEvents(fromAddress, eventConfig, this.l2Weth);
      return this.convertEventListToBridgeEvents(matchL2EthDepositAndWrapEvents(l2EthDepositEvents, l2EthWrapEvents));
    } else {
      // Since we can only index on the `fromAddress` for the DepositFinalized event, we can't support
      // monitoring the spoke pool address
      if (fromAddress !== this.hubPoolAddress) {
        return this.convertEventListToBridgeEvents([]);
      }

      return this.convertEventListToBridgeEvents(
        await paginatedEventQuery(
          this.getL2Bridge(),
          this.getL2Bridge().filters.DepositFinalized(ZERO_ADDRESS, undefined, fromAddress),
          eventConfig
        )
      );
    }
  }

  async isHubChainContract(address: string): Promise<boolean> {
    return utils.isContractDeployedToAddress(address, this.getL1Bridge().provider);
  }
  async isL2ChainContract(address: string): Promise<boolean> {
    return utils.isContractDeployedToAddress(address, this.getL2Bridge().provider);
  }

  private queryL2WrapEthEvents(
    fromAddress: string,
    eventConfig: EventSearchConfig,
    l2Weth = this.l2Weth
  ): Promise<Log[]> {
    return paginatedEventQuery(l2Weth, l2Weth.filters.Deposit(fromAddress), eventConfig);
  }
}
