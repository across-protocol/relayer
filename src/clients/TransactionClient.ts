/* eslint-disable @typescript-eslint/no-explicit-any */
import {
  winston,
  getNetworkName,
  Contract,
  runTransaction,
  BigNumber,
  etherscanLink,
  TransactionResponse,
  TransactionSimulationResult,
  willSucceed,
} from "../utils";

export interface AugmentedTransaction {
  contract: Contract;
  chainId: number;
  method: string;
  args: any[];
  message?: string;
  mrkdwn?: string;
  value?: BigNumber;
  unpermissioned?: boolean; // If false, the transaction must be sent from the enqueuer of the method.
  // If true, then can be sent from the MakerDAO multisender contract.
  canFailInSimulation?: boolean;
}

export class TransactionClient {
  // eslint-disable-next-line no-useless-constructor
  constructor(readonly logger: winston.Logger) {}

  protected _simulate(txn: AugmentedTransaction): Promise<TransactionSimulationResult> {
    return willSucceed(txn);
  }

  // Each transaction is simulated in isolation; but on-chain execution may produce different
  // results due to execution sequence or intermediate changes in on-chain state.
  simulate(txns: AugmentedTransaction[]): Promise<TransactionSimulationResult[]> {
    return Promise.all(txns.map((txn: AugmentedTransaction) => this._simulate(txn)));
  }

  protected async _submit(txn: AugmentedTransaction, nonce: number | null = null): Promise<TransactionResponse> {
    const { contract, method, args, value } = txn;
    return runTransaction(this.logger, contract, method, args, value, null, nonce);
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
    let nonce: number | null = null;
    for (let idx = 0; idx < txns.length; ++idx) {
      const txn: AugmentedTransaction = txns[idx];
      let response: TransactionResponse;
      if (nonce !== null) this.logger.debug({ at: "TransactionClient#submit", message: `Using nonce ${nonce}.` });

      try {
        response = await this._submit(txn, nonce);
      } catch (error) {
        this.logger.info({
          at: "TransactionClient#submit",
          message: `Transaction ${idx + 1} submission on ${networkName} failed or timed out.`,
          mrkdwn,
          error,
          notificationPath: "across-error",
        });
        return txnResponses;
      }

      nonce = response.nonce + 1;
      const blockExplorer = etherscanLink(response.hash, txn.chainId);
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
