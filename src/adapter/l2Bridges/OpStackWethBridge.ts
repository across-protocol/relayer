import { CONTRACT_ADDRESSES } from "../../common";
import {
  BigNumber,
  bnZero,
  Contract,
  createFormatFunction,
  EventSearchConfig,
  getNetworkName,
  isDefined,
  paginatedEventQuery,
  Provider,
  Signer,
  toBN,
  EvmAddress,
  getTokenInfo,
} from "../../utils";
import { BaseL2BridgeAdapter } from "./BaseL2BridgeAdapter";
import WETH_ABI from "../../common/abi/Weth.json";
import { AugmentedTransaction } from "../../clients/TransactionClient";

export class OpStackWethBridge extends BaseL2BridgeAdapter {
  constructor(
    l2chainId: number,
    hubChainId: number,
    l2Signer: Signer,
    l1Provider: Provider | Signer,
    l1Token: EvmAddress
  ) {
    super(l2chainId, hubChainId, l2Signer, l1Provider, l1Token);

    const { address, abi } = CONTRACT_ADDRESSES[l2chainId].ovmStandardBridge;
    this.l2Bridge = new Contract(address, abi, l2Signer);
    const { address: l1Address, abi: l1Abi } = CONTRACT_ADDRESSES[hubChainId][`ovmStandardBridge_${l2chainId}`];
    this.l1Bridge = new Contract(l1Address, l1Abi, l1Provider);
  }

  constructWithdrawToL1Txns(
    toAddress: EvmAddress,
    l2Token: EvmAddress,
    _l1Token: EvmAddress,
    amount: BigNumber
  ): Promise<AugmentedTransaction[]> {
    const weth = new Contract(l2Token.toNative(), WETH_ABI, this.l2Signer);
    const { decimals, symbol } = getTokenInfo(l2Token, this.l2chainId);
    const formatter = createFormatFunction(2, 4, false, decimals);
    const unwrapTxn: AugmentedTransaction = {
      contract: weth,
      chainId: this.l2chainId,
      method: "withdraw",
      args: [amount],
      nonMulticall: true,
      message: "🎰 Unwrapped WETH on OpStack before withdrawing to L1",
      mrkdwn: `Unwrapped ${formatter(amount.toString())} WETH before withdrawing from ${getNetworkName(
        this.l2chainId
      )} to L1`,
    };
    const withdrawTxn: AugmentedTransaction = {
      contract: this.l2Bridge,
      chainId: this.l2chainId,
      method: "bridgeETHTo",
      args: [
        toAddress.toNative(), // to
        200_000, // minGasLimit
        "0x", // extraData
      ],
      nonMulticall: true,
      canFailInSimulation: true, // This will fail in simulation unless we simulate adding the WETH balance
      // to the relayer.
      value: amount,
      message: "🎰 Withdrew OpStack WETH to L1",
      mrkdwn: `Withdrew ${formatter(amount.toString())} ${symbol} from ${getNetworkName(this.l2chainId)} to L1`,
    };
    return Promise.resolve([unwrapTxn, withdrawTxn]);
  }

  async getL2PendingWithdrawalAmount(
    l2EventConfig: EventSearchConfig,
    l1EventConfig: EventSearchConfig,
    fromAddress: EvmAddress,
    _l2Token: EvmAddress
  ): Promise<BigNumber> {
    _l2Token; // unused
    const [withdrawalInitiatedEvents, withdrawalFinalizedEvents] = await Promise.all([
      paginatedEventQuery(
        this.l2Bridge,
        this.l2Bridge.filters.ETHBridgeInitiated(
          fromAddress.toNative() // from
        ),
        l2EventConfig
      ),
      paginatedEventQuery(
        this.l1Bridge,
        this.l1Bridge.filters.ETHBridgeFinalized(
          fromAddress.toNative() // from
        ),
        l1EventConfig
      ),
    ]);
    const counted = new Set<number>();
    const withdrawalAmount = withdrawalInitiatedEvents.reduce((totalAmount, { args: l2Args }) => {
      const received = withdrawalFinalizedEvents.find(({ args: l1Args }, idx) => {
        // Protect against double-counting the same l1 withdrawal events.
        // @dev: If we begin to send "fast-finalized" messages via CCTP V2 then the amounts will not exactly match
        // and we will need to adjust this logic.
        if (counted.has(idx) || !toBN(l1Args.amount.toString()).eq(toBN(l2Args.amount.toString()))) {
          return false;
        }

        counted.add(idx);
        return true;
      });

      return isDefined(received) ? totalAmount : totalAmount.add(l2Args.amount);
    }, bnZero);
    return withdrawalAmount;
  }
}
