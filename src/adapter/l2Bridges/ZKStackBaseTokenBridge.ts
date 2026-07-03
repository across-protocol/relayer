import { getContractEntry } from "../../common";
import {
  BigNumber,
  bnZero,
  compareAddressesSimple,
  Contract,
  createFormatFunction,
  EventSearchConfig,
  EvmAddress,
  getNetworkName,
  getTokenInfo,
  isDefined,
  paginatedEventQuery,
  Signer,
  toBN,
  ZERO_BYTES,
} from "../../utils";
import { BaseL2BridgeAdapter } from "./BaseL2BridgeAdapter";
import WETH_ABI from "../../common/abi/Weth.json";
import { AugmentedTransaction } from "../../clients/TransactionClient";

/**
 * Withdraws a ZkStack chain's custom base token (e.g. (W)GHO on Lens) back to the L1 withdrawal recipient.
 * The input L2 token is the WETH9-style wrapper of the base token (e.g. WGHO), which is first unwrapped and
 * then withdrawn via the L2BaseToken system contract, mirroring how the corresponding SpokePool bridges the
 * wrapped base token back to the HubPool (see Lens_SpokePool._bridgeTokensToHubPool()). On L1, the withdrawal
 * is finalized against the L1Nullifier and releases the chain's L1 base token (e.g. WGHO on Mainnet) from the
 * L1 NativeTokenVault. Withdrawal finalizations on L1 are handled by the zkSync finalizer.
 */
export class ZKStackBaseTokenBridge extends BaseL2BridgeAdapter {
  constructor(l2chainId: number, hubChainId: number, l2Signer: Signer, l1Signer: Signer, l1Token: EvmAddress) {
    super(l2chainId, hubChainId, l2Signer, l1Signer, l1Token);

    const { address, abi } = getContractEntry(l2chainId, "l2BaseToken");
    this.l2Bridge = new Contract(address, abi, l2Signer);
    // Base token withdrawals are finalized on L1 by releasing the L1 base token from the NativeTokenVault,
    // so track finalizations there.
    const { address: l1Address, abi: l1Abi } = getContractEntry(hubChainId, "zkStackNativeTokenVault");
    this.l1Bridge = new Contract(l1Address, l1Abi, l1Signer);
  }

  constructWithdrawToL1Txns(
    toAddress: EvmAddress,
    l2Token: EvmAddress,
    _l1Token: EvmAddress,
    amount: BigNumber
  ): Promise<AugmentedTransaction[]> {
    const wrappedBaseToken = new Contract(l2Token.toNative(), WETH_ABI, this.l2Signer);
    const { decimals, symbol } = getTokenInfo(l2Token, this.l2chainId);
    const formatter = createFormatFunction(2, 4, false, decimals);
    const unwrapTxn: AugmentedTransaction = {
      contract: wrappedBaseToken,
      chainId: this.l2chainId,
      method: "withdraw",
      args: [amount],
      nonMulticall: true,
      ensureConfirmation: true,
      message: `🎰 Unwrapped ${symbol} on ZkStack chain before withdrawing to L1`,
      mrkdwn: `Unwrapped ${formatter(amount.toString())} ${symbol} before withdrawing from ${getNetworkName(
        this.l2chainId
      )} to L1`,
    };
    const withdrawTxn: AugmentedTransaction = {
      contract: this.getL2Bridge(),
      chainId: this.l2chainId,
      method: "withdraw",
      args: [
        toAddress.toNative(), // _l1Receiver
      ],
      nonMulticall: true,
      canFailInSimulation: true, // This will fail in simulation unless we simulate adding the unwrapped base token
      // balance to the relayer.
      value: amount,
      message: "🎰 Withdrew ZkStack base token to L1",
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
    const assetId = await this.getL1Bridge().assetId(this.l1Token.toNative());
    if (assetId === ZERO_BYTES) {
      throw new Error(`Undefined assetId for L1 token ${this.l1Token}`);
    }
    const [withdrawalInitiatedEvents, withdrawalFinalizedEvents] = await Promise.all([
      paginatedEventQuery(
        this.getL2Bridge(),
        this.getL2Bridge().filters.Withdrawal(
          fromAddress.toNative() // _l2Sender
        ),
        l2EventConfig
      ),
      paginatedEventQuery(
        this.getL1Bridge(),
        this.getL1Bridge().filters.BridgeMint(this.l2chainId, assetId),
        l1EventConfig
      ),
    ]);
    // The receiver is not an indexed field on BridgeMint so filter here. EOA rebalance withdrawals always set the
    // L1 recipient to the withdrawing address.
    const finalizedToFromAddress = withdrawalFinalizedEvents.filter(({ args }) =>
      compareAddressesSimple(args.receiver, fromAddress.toNative())
    );
    const counted = new Set<number>();
    const withdrawalAmount = withdrawalInitiatedEvents.reduce((totalAmount, { args: l2Args }) => {
      const received = finalizedToFromAddress.find(({ args: l1Args }, idx) => {
        // Protect against double-counting the same l1 withdrawal events.
        if (counted.has(idx) || !toBN(l1Args.amount.toString()).eq(toBN(l2Args._amount.toString()))) {
          return false;
        }

        counted.add(idx);
        return true;
      });

      return isDefined(received) ? totalAmount : totalAmount.add(l2Args._amount);
    }, bnZero);
    return withdrawalAmount;
  }

  public pendingWithdrawalLookbackPeriodSeconds(): number {
    return 2 * 24 * 60 * 60 + 60 * 60; // ZkStack batches typically execute on L1 within ~24 hours; pad to 2 days
    // + 1 hour to account for the time needed to finalize the withdrawal once the batch has executed.
  }
}
