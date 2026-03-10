import {
  BigNumber,
  bnZero,
  Contract,
  EventSearchConfig,
  getNetworkName,
  Signer,
  EvmAddress,
  CHAIN_IDs,
  paginatedEventQuery,
} from "../../utils";
import { BaseL2BridgeAdapter } from "./BaseL2BridgeAdapter";
import { AugmentedTransaction } from "../../clients/TransactionClient";
import { BRIDGE_API_MINIMUMS } from "../../adapter/bridges";
import ERC20_ABI from "../../common/abi/MinimalERC20.json";

export class BridgeApi extends BaseL2BridgeAdapter {
  constructor(l2chainId: number, hubChainId: number, l2Signer: Signer, l1Signer: Signer, l1Token: EvmAddress) {
    if (hubChainId !== CHAIN_IDs.MAINNET) {
      throw new Error("Cannot define a Bridge API bridge for a non-production network");
    }
    super(l2chainId, hubChainId, l2Signer, l1Signer, l1Token);
  }

  async constructWithdrawToL1Txns(
    toAddress: EvmAddress,
    l2Token: EvmAddress,
    l1Token: EvmAddress,
    amount: BigNumber
  ): Promise<AugmentedTransaction[]> {
    // If amount is less than the network minimums, then throw.
    if (amount.lt(BRIDGE_API_MINIMUMS[this.hubChainId])) {
      throw new Error(`Cannot bridge to ${getNetworkName(this.hubChainId)} due to invalid amount ${amount}`);
    }
    // Get the transfer route source address. @todo
    const transferRouteSource = await this.getTransferRouteEscrowAddress(toAddress, l1Token, l2Token);
    const l2TokenContract = new Contract(l2Token.toNative(), ERC20_ABI, this.l2Signer);
    const transferTxn = {
      contract: l2TokenContract,
      method: "transfer",
      chainId: this.l2chainId,
      args: [transferRouteSource, amount],
    };
    return [transferTxn];
  }

  async getL2PendingWithdrawalAmount(
    l2EventConfig: EventSearchConfig,
    l1EventConfig: EventSearchConfig,
    fromAddress: EvmAddress,
    l2Token: EvmAddress
  ): Promise<BigNumber> {
    const expectedL2Recipient = await this.getTransferRouteEscrowAddress(fromAddress, this.l1Token, l2Token);
    const l2TokenContract = new Contract(l2Token.toNative(), ERC20_ABI, this.l2Signer);
    const l1TokenContract = new Contract(this.l1Token.toNative(), ERC20_ABI, this.l1Signer);

    const [l2TransferEvents, l1TransferEvents] = await Promise.all([
      paginatedEventQuery(
        l2TokenContract,
        l2TokenContract.filters.Transfer(fromAddress.toNative(), expectedL2Recipient),
        l2EventConfig
      ),
      paginatedEventQuery(
        l1TokenContract,
        l1TokenContract.filters.Transfer(expectedL2Recipient, fromAddress.toNative()),
        l1EventConfig
      ),
    ]);
    const l1TransferAmounts = l1TransferEvents.map(({ args }) => args.value.toString());

    // Expect a 1:1 transfer. Match out events by amounts.
    const outstandingAmount = l2TransferEvents.reduce((acc, event) => {
      const l2Amount = event.args.value;
      if (l1TransferAmounts.some((l1Amount) => l1Amount === l2Amount.toString())) {
        // Finalization event found. Remove it from observed.
        const amountIndex = l1TransferAmounts.indexOf(l2Amount.toString());
        l1TransferEvents.splice(amountIndex, 1);
      } else {
        // Finalization event not found. Add it to pending amounts.
        acc = acc.add(l2Amount);
      }
      return acc;
    }, bnZero);

    return outstandingAmount;
  }

  async getTransferRouteEscrowAddress(
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    fromAddress: EvmAddress,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    l1Token: EvmAddress,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    l2Token: EvmAddress
  ): Promise<string> {
    // @todo based on the structure of data returned by the bridge API.
    return this.l2Signer.getAddress();
  }
}
