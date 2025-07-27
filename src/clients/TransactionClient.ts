/* eslint-disable @typescript-eslint/no-explicit-any */
import { utils as sdkUtils, typeguards } from "@across-protocol/sdk";
import {
  winston,
  getNetworkName,
  Contract,
  runTransaction,
  BigNumber,
  blockExplorerLink,
  toBNWei,
  TransactionResponse,
  TransactionSimulationResult,
  willSucceed,
  stringifyThrownValue,
} from "../utils";

export interface AugmentedTransaction {
  contract: Contract;
  chainId: number;
  method: string;
  args: any[];
  gasLimit?: BigNumber;
  gasLimitMultiplier?: number;
  message?: string;
  mrkdwn?: string;
  value?: BigNumber;
  unpermissioned?: boolean; // If false, the transaction must be sent from the enqueuer of the method.
  // If true, then can be sent from the MakerDAO multisender contract.
  canFailInSimulation?: boolean;
  // Optional batch ID to use to group transactions
  groupId?: string;
  // If true, the transaction is being sent to a non Multicall contract so we can't batch it together
  // with other transactions.
  nonMulticall?: boolean;
}

const { fixedPointAdjustment: fixedPoint } = sdkUtils;
const { isError } = typeguards;

const DEFAULT_GASLIMIT_MULTIPLIER = 1.0;

export class TransactionClient {
  readonly nonces: { [chainId: number]: number } = {};
  private _simulatedBeforeSubmit = false;

  // eslint-disable-next-line no-useless-constructor
  constructor(readonly logger: winston.Logger) {}

  protected _simulate(txn: AugmentedTransaction): Promise<TransactionSimulationResult> {
    return willSucceed(txn);
  }

  /**
   * @notice Simulates transactions and returns the simulation results. Should not crash if any of the transactions fail
   * and instead return the simulation results as either successful or failed results.
   * @dev Each transaction is simulated in isolation; but on-chain execution may produce different
   * results due to execution sequence or intermediate changes in on-chain state.
   * @param txns - The transactions to simulate.
   * @returns The simulation results.
   */
  simulate(txns: AugmentedTransaction[]): Promise<TransactionSimulationResult[]> {
    this._simulatedBeforeSubmit = true;
    return Promise.all(txns.map((txn: AugmentedTransaction) => this._simulate(txn)));
  }

  protected _submit(txn: AugmentedTransaction, nonce: number | null = null): Promise<TransactionResponse> {
    const { contract, method, args, value, gasLimit } = txn;
    return runTransaction(this.logger, contract, method, args, value, gasLimit, nonce);
  }

  /**
   * @notice This function submits transactions and returns the transaction responses. This should not
   * crash if any of the transactions fail and instead return the transaction responses as either successful or failed
   * responses.
   * @dev The caller mshouldust call simulate() first and handle the error, otherwise this function might crash silently
   * unexpectedly.
   * @param chainId - The chain ID to submit the transactions to.
   * @param txns - The transactions to submit.
   * @returns The transaction responses.
   */
  async submit(chainId: number, txns: AugmentedTransaction[]): Promise<TransactionResponse[]> {
    if (!this._simulatedBeforeSubmit) {
      // Force user to call simulateFirst() first and handle the error, otherwise this function might crash silently
      // because any errors thrown by _submit() are caught.
      this.logger.warn({
        at: "TransactionClient#submit",
        message: "TransactionClient#submit() called before simulate()",
      });
    }
    this._simulatedBeforeSubmit = false;

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

      const nonce = this.nonces[chainId] ? this.nonces[chainId] + 1 : undefined;

      // @dev It's assumed that nobody ever wants to discount the gasLimit.
      const gasLimitMultiplier = txn.gasLimitMultiplier ?? DEFAULT_GASLIMIT_MULTIPLIER;
      if (gasLimitMultiplier > DEFAULT_GASLIMIT_MULTIPLIER) {
        this.logger.debug({
          at: "TransactionClient#_submit",
          message: `Padding gasLimit estimate on ${txn.method} transaction.`,
          estimate: txn.gasLimit,
          gasLimitMultiplier,
        });
        txn.gasLimit = txn.gasLimit?.mul(toBNWei(gasLimitMultiplier)).div(fixedPoint);
      }

      let response: TransactionResponse;
      try {
        response = await this._submit(txn, nonce);
      } catch (error) {
        delete this.nonces[chainId];
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

      this.nonces[chainId] = response.nonce;
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
}
