import { typeguards } from "@across-protocol/sdk";
import {
  winston,
  Contract,
  Signer,
  Provider,
  TransactionResponse,
  getNetworkName,
  toBNWei,
  stringifyThrownValue,
  blockExplorerLink,
  fixedPointAdjustment,
  isDefined,
} from "../utils";

import { AugmentedTransaction, TransactionClient } from "./";

const { isError } = typeguards;

export class Dispatcher extends TransactionClient {
  private noncesBySigner: { [chainId: number]: { [signerAddress: string]: number } } = {};
  private activeSignerIndex = 0;

  // eslint-disable-next-line no-useless-constructor
  constructor(readonly logger: winston.Logger, readonly signers: Signer[]) {
    if (signers.length == 0) {
      throw new Error("Cannot build dispatcher with no signers");
    }
    super(logger);
  }

  async dispatch(
    txn: Omit<AugmentedTransaction, "contract">,
    target: Contract,
    provider: Provider
  ): Promise<TransactionResponse> {
    // Overwrite the signer on the augmented transaction.
    const signer = this.rotateSigners();
    const contract = target.connect(signer.connect(provider));
    const dispatchTxn = {
      ...txn,
      contract,
    };
    return (await this.submit(txn.chainId, [dispatchTxn]))[0];
  }

  async submit(chainId: number, txns: AugmentedTransaction[]): Promise<TransactionResponse[]> {
    const networkName = getNetworkName(chainId);
    const txnResponses: TransactionResponse[] = [];

    this.logger.debug({
      at: "TransactionClient#submit",
      message: `Processing ${txns.length} transactions.`,
    });

    // Transactions are submitted sequentially to avoid nonce collisions. More
    // advanced nonce management may permit them to be submitted in parallel.
    let mrkdwn = "";
    for (let idx = 0; idx < txns.length; ++idx) {
      const txn = txns[idx];

      if (txn.chainId !== chainId) {
        throw new Error(`chainId mismatch for method ${txn.method} (${txn.chainId} !== ${chainId})`);
      }

      const signerAddr = await txn.contract.signer.getAddress();
      const chainNonceMap = (this.noncesBySigner[chainId] ??= {});
      const nonce = isDefined(chainNonceMap[signerAddr]) ? chainNonceMap[signerAddr] + 1 : undefined;

      // @dev It's assumed that nobody ever wants to discount the gasLimit.
      const gasLimitMultiplier = txn.gasLimitMultiplier ?? this.DEFAULT_GAS_LIMIT_MULTIPLIER;
      if (gasLimitMultiplier > this.DEFAULT_GAS_LIMIT_MULTIPLIER) {
        this.logger.debug({
          at: "TransactionClient#_submit",
          message: `Padding gasLimit estimate on ${txn.method} transaction.`,
          estimate: txn.gasLimit,
          gasLimitMultiplier,
        });
        txn.gasLimit = txn.gasLimit?.mul(toBNWei(gasLimitMultiplier)).div(fixedPointAdjustment);
      }

      let response: TransactionResponse;
      try {
        response = await this._submit(txn, { nonce });
      } catch (error) {
        delete chainNonceMap[signerAddr];
        this.logger.info({
          at: "TransactionClient#submit",
          message: `Transaction ${idx + 1} submission on ${networkName} failed or timed out.`,
          mrkdwn,
          // @dev `error` _sometimes_ doesn't decode correctly (especially on Polygon), so fish for the reason.
          errorMessage: isError(error) ? (error as Error).message : undefined,
          error: stringifyThrownValue(error),
          notificationPath: "across-error",
        });
        return txnResponses;
      }

      chainNonceMap[signerAddr] = response.nonce;
      const blockExplorer = blockExplorerLink(response.hash, txn.chainId);
      mrkdwn += `  ${idx + 1}. ${txn.message || "No message"} (${blockExplorer}): ${txn.mrkdwn || "No markdown"}\n`;
      txnResponses.push(response);
    }

    this.logger.info({
      at: "TransactionClient#submit",
      message: `Completed ${networkName} transaction submission! 🧙`,
      mrkdwn,
    });

    return txnResponses;
  }

  private rotateSigners(): Signer {
    const activeSigner = this.signers[this.activeSignerIndex];
    this.activeSignerIndex = (this.activeSignerIndex + 1) % this.signers.length;
    return activeSigner;
  }
}
