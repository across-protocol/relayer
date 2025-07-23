import { CONTRACT_ADDRESSES } from "../../common";
import { AugmentedTransaction } from "../../clients/TransactionClient";
import ERC20_ABI from "../../common/abi/MinimalERC20.json";
import {
  BigNumber,
  bnZero,
  Contract,
  createFormatFunction,
  EventSearchConfig,
  getNetworkName,
  isDefined,
  MAX_SAFE_ALLOWANCE,
  paginatedEventQuery,
  Provider,
  Signer,
  EvmAddress,
  getTokenInfo,
  toBN,
} from "../../utils";
import { BaseL2BridgeAdapter } from "./BaseL2BridgeAdapter";

export class OpStackUSDCBridge extends BaseL2BridgeAdapter {
  readonly minGasLimit = 200_000;

  constructor(
    l2chainId: number,
    hubChainId: number,
    l2Signer: Signer,
    l1Provider: Provider | Signer,
    l1Token: EvmAddress
  ) {
    super(l2chainId, hubChainId, l2Signer, l1Provider, l1Token);

    const { address: l2Address, abi: l2ABI } = CONTRACT_ADDRESSES[l2chainId].opUSDCBridge;
    this.l2Bridge = new Contract(l2Address, l2ABI, l2Signer);

    const { address: l1Address, abi: l1ABI } = CONTRACT_ADDRESSES[hubChainId][`opUSDCBridge_${l2chainId}`];
    this.l1Bridge = new Contract(l1Address, l1ABI, l1Provider);
  }

  async constructWithdrawToL1Txns(
    to: EvmAddress,
    l2Token: EvmAddress,
    _l1Token: EvmAddress,
    amount: BigNumber
  ): Promise<AugmentedTransaction[]> {
    const { l2chainId: chainId, l2Bridge } = this;

    const txns: AugmentedTransaction[] = [];
    const { decimals, symbol } = getTokenInfo(l2Token, this.l2chainId);
    const formatter = createFormatFunction(2, 4, false, decimals);

    const erc20 = new Contract(l2Token.toNative(), ERC20_ABI, this.l2Signer);
    const formattedAmount = formatter(amount.toString());
    const chain = getNetworkName(chainId);
    const nonMulticall = true;
    const unpermissioned = false;

    const allowance = await erc20.allowance(await this.l2Signer.getAddress(), l2Bridge.address);
    if (allowance.lt(amount)) {
      // Approval must be in place before withdrawal is enqueued. Catch the withdrawal on the next run.
      txns.push({
        chainId,
        contract: erc20,
        method: "approve",
        args: [l2Bridge.address, MAX_SAFE_ALLOWANCE],
        nonMulticall,
        unpermissioned,
        message: `✅ Approved Circle Bridged (upgradable) ${symbol} for withdrawal from ${chain}.`,
      });
    } else {
      txns.push({
        chainId,
        contract: l2Bridge,
        method: "sendMessage",
        args: [to.toNative(), amount.toString(), this.minGasLimit],
        nonMulticall,
        unpermissioned,
        message: `🎰 Withdrew ${formattedAmount} Circle Bridged (upgradable) ${symbol} from ${chain} to L1`,
      });
    }

    return Promise.resolve(txns);
  }

  async getL2PendingWithdrawalAmount(
    l2EventConfig: EventSearchConfig,
    l1EventConfig: EventSearchConfig,
    from: EvmAddress,
    _l2Token: EvmAddress
  ): Promise<BigNumber> {
    _l2Token; // unused

    const sentFilter = this.l2Bridge.filters.MessageSent(from.toNative());
    const receiveFilter = this.l1Bridge.filters.MessageReceived(from.toNative());

    const [l2Events, l1Events] = await Promise.all([
      paginatedEventQuery(this.l2Bridge, sentFilter, l2EventConfig),
      paginatedEventQuery(this.l1Bridge, receiveFilter, l1EventConfig),
    ]);

    const counted = new Set<number>();
    const withdrawalAmount = l2Events.reduce((totalAmount, { args: l2Args }) => {
      const received = l1Events.find(({ args: l1Args }, idx) => {
        // Protect against double-counting the same l1 withdrawal events.
        // @dev: If we begin to send "fast-finalized" messages via CCTP V2 then the amounts will not exactly match
        // and we will need to adjust this logic.
        if (counted.has(idx) || !toBN(l1Args._amount.toString()).eq(toBN(l2Args._amount.toString()))) {
          return false;
        }

        counted.add(idx);
        return true;
      });

      return isDefined(received) ? totalAmount : totalAmount.add(l2Args._amount);
    }, bnZero);

    return withdrawalAmount;
  }
}
