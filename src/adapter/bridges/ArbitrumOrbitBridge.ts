import {
  Contract,
  BigNumber,
  paginatedEventQuery,
  Signer,
  EventSearchConfig,
  Provider,
  toBN,
  toWei,
  TOKEN_SYMBOLS_MAP,
  isDefined,
  ethers,
  bnZero,
  CHAIN_IDs,
} from "../../utils";
import { CONTRACT_ADDRESSES, CUSTOM_ARBITRUM_GATEWAYS, DEFAULT_ARBITRUM_GATEWAY } from "../../common";
import { BridgeTransactionDetails, BaseBridgeAdapter, BridgeEvents } from "./BaseBridgeAdapter";
import { processEvent } from "../utils";
import { PUBLIC_NETWORKS } from "@across-protocol/constants";

const bridgeSubmitValue: { [chainId: number]: BigNumber } = {
  [CHAIN_IDs.ARBITRUM]: toWei(0.013),
  [CHAIN_IDs.ALEPH_ZERO]: toWei(0.45),
  // Testnet
  [CHAIN_IDs.ARBITRUM_SEPOLIA]: toWei(0.013),
};

const maxFeePerGas: { [chainId: number]: BigNumber } = {
  [CHAIN_IDs.ARBITRUM]: toBN(20e9),
  [CHAIN_IDs.ALEPH_ZERO]: toBN(24e10),
  // Testnet
  [CHAIN_IDs.ARBITRUM_SEPOLIA]: toBN(20e9),
};

export class ArbitrumOrbitBridge extends BaseBridgeAdapter {
  protected l1GatewayRouter: Contract;

  private readonly transactionSubmissionData =
    "0x000000000000000000000000000000000000000000000000002386f26fc1000000000000000000000000000000000000000000000000000000000000000000400000000000000000000000000000000000000000000000000000000000000000";
  private readonly l2GasLimit = toBN(150000);
  private readonly l2GasPrice;
  private readonly l1SubmitValue;

  constructor(
    l2chainId: number,
    hubChainId: number,
    l1Signer: Signer,
    l2SignerOrProvider: Signer | Provider,
    l1Token: string
  ) {
    const { address: gatewayAddress, abi: gatewayRouterAbi } =
      CONTRACT_ADDRESSES[hubChainId][`orbitErc20GatewayRouter_${l2chainId}`];
    const { l1: l1Address, l2: l2Address } =
      CUSTOM_ARBITRUM_GATEWAYS[l2chainId]?.[l1Token] ?? DEFAULT_ARBITRUM_GATEWAY[l2chainId];
    const l1Abi = CONTRACT_ADDRESSES[hubChainId][`orbitErc20Gateway_${l2chainId}`].abi;
    const l2Abi = CONTRACT_ADDRESSES[l2chainId].erc20Gateway.abi;

    super(l2chainId, hubChainId, l1Signer, l2SignerOrProvider, [l1Address]);

    const nativeToken = PUBLIC_NETWORKS[l2chainId].nativeToken;
    // Only set nonstandard gas tokens.
    if (nativeToken !== "ETH") {
      this.gasToken = TOKEN_SYMBOLS_MAP[nativeToken].addresses[hubChainId];
    }
    this.l1SubmitValue = bridgeSubmitValue[l2chainId];
    this.l2GasPrice = maxFeePerGas[l2chainId];
    this.l1Bridge = new Contract(l1Address, l1Abi, l1Signer);
    this.l2Bridge = new Contract(l2Address, l2Abi, l2SignerOrProvider);
    this.l1GatewayRouter = new Contract(gatewayAddress, gatewayRouterAbi, l1Signer);
  }

  async constructL1ToL2Txn(
    toAddress: string,
    l1Token: string,
    l2Token: string,
    amount: BigNumber
  ): Promise<BridgeTransactionDetails> {
    const { l1GatewayRouter, l2GasLimit, l2GasPrice, l1SubmitValue } = this;
    const transactionSubmissionData = isDefined(this.gasToken)
      ? ethers.utils.defaultAbiCoder.encode(
          ["uint256", "bytes", "uint256"],
          [l1SubmitValue, "0x", l2GasLimit.mul(l2GasPrice).add(l1SubmitValue)]
        )
      : this.transactionSubmissionData;
    return Promise.resolve({
      contract: l1GatewayRouter,
      method: "outboundTransfer",
      args: [l1Token, toAddress, amount, l2GasLimit, l2GasPrice, transactionSubmissionData],
      value: isDefined(this.gasToken) ? bnZero : l1SubmitValue,
    });
  }

  async queryL1BridgeInitiationEvents(
    l1Token: string,
    fromAddress: string,
    toAddress: string,
    eventConfig: EventSearchConfig
  ): Promise<BridgeEvents> {
    const events = await paginatedEventQuery(
      this.getL1Bridge(),
      this.getL1Bridge().filters.DepositInitiated(undefined, undefined, toAddress),
      eventConfig
    );
    return {
      [this.resolveL2TokenAddress(l1Token)]: events
        .filter(({ args }) => args.l1Token === l1Token)
        .map((event) => processEvent(event, "_amount", "_to", "_from")),
    };
  }

  async queryL2BridgeFinalizationEvents(
    l1Token: string,
    fromAddress: string,
    toAddress: string,
    eventConfig: EventSearchConfig
  ): Promise<BridgeEvents> {
    const events = await paginatedEventQuery(
      this.getL2Bridge(),
      this.getL2Bridge().filters.DepositFinalized(l1Token, undefined, toAddress),
      eventConfig
    );
    return {
      [this.resolveL2TokenAddress(l1Token)]: events.map((event) => processEvent(event, "amount", "to", "from")),
    };
  }
}
