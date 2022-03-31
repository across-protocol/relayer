import { winston, Transaction, Contract, toBN } from "../utils";
interface preSignedTransaction {
  contract: Contract;
  method: string;
  args: any;
  message: string;
}

export class MultiCallBundler {
  private transactions: preSignedTransaction[] = [];
  constructor(readonly logger: winston.Logger, readonly gasEstimator: any) {}

  // Adds all information associated with a transaction to the transaction queue. This is the intention of the
  // caller to send a transaction. The transaction might not be executable, which should be filtered later.
  enqueueTransaction(contract: Contract, method: string, args: any, message: string) {
    if (contract) this.transactions.push({ contract, method, args, message });
  }

  transactionCount() {
    return this.transactions.length;
  }

  clearTransactionQueue() {
    this.transactions = [];
  }

  getTargetForTxIndex(index: number) {
    return { target: this.transactions[index].contract.address };
  }

  async executeTransactionQueue() {
    try {
      this.logger.debug({ at: "MultiCallBundler", message: "Executing tx bundle", number: this.transactions.length });

      // Simulate the transaction execution for the whole queue.
      const transactionsWillSucceed = await Promise.all(
        this.transactions.map(async (tx: preSignedTransaction) => this.willSucceed(tx.contract, tx.method, tx.args))
      );
      console.log("transactionsWillSucceed", transactionsWillSucceed);

      // If any transactions will revert then log the reason and remove them from the transaction queue.
      if (transactionsWillSucceed.every((willSucceed) => !willSucceed))
        this.logger.error({
          at: "MultiCallBundler",
          message: "Some transaction in the queue are reverting!",
          revertingTransactions: transactionsWillSucceed.map((succeed, index) =>
            succeed ? null : { target: this.getTargetForTxIndex(index), msg: this.transactions[index].message }
          ),
        });
      transactionsWillSucceed.forEach((succeed, index) => (succeed ? null : this.transactions.splice(index, 1)));

      // Group by target chain.
      let groupedTransactions = {};

      for (const element of this.transactions) {
        const chainId = (element.contract.provider as any).network.chainId;
        if (!groupedTransactions[chainId]) groupedTransactions[chainId] = [];
        groupedTransactions[chainId].push(element);
      }

      // Execute and wait for all transactions to be mined.

      const transactionResults = await Promise.allSettled(
        this.transactions.map((tx: preSignedTransaction) => this.runTransaction(tx.contract, tx.method, tx.args))
      );

      const transactionReceipts = await Promise.allSettled(
        transactionResults.map((transaction: any) => transaction.wait())
      );

      this.logger.debug({
        at: "MultiCallBundler",
        message: "All transactions executed",
        hashes: transactionReceipts.map((receipt: any) => {
          receipt.status == "fulfilled" ? receipt.value.transactionHash : "Tx thrown";
        }),
      });
      // return transactionReceipts;
    } catch (error) {
      this.logger.error({ at: "MultiCallBundler", message: "Error executing tx bundle", error });
    }
  }

  // Note that this function will throw if the call to the contract on method for given args reverts. Implementers
  // of this method should be considerate of this and catch the response to deal with the error accordingly.
  async runTransaction(contract: Contract, method: string, args: any) {
    try {
      const gas = await this.getGasPrice(contract.provider);
      this.logger.debug({ at: "MultiCallBundler", message: "sending tx", target: contract.address, method, args, gas });
      return await contract[method](...args, gas);
    } catch (error) {
      throw new Error(error.reason); // Extract the reason from the transaction error and throw it.
    }
  }

  //TODO: add in gasPrice when the SDK has this for the given chainId.
  // For now this method will extract the provider's Fee data from the associated network and scale it by a priority
  // scaler. This works on both mainnet and L2's by the utility switching the response structure accordingly.
  async getGasPrice(provider, priorityScaler = toBN(1.2)) {
    const feeData = await provider.getFeeData();
    if (feeData.maxFeePerGas && feeData.maxPriorityFeePerGas)
      return {
        maxFeePerGas: feeData.maxFeePerGas.mul(priorityScaler),
        maxPriorityFeePerGas: feeData.maxPriorityFeePerGas.mul(priorityScaler),
      };
    else return { gasPrice: feeData.gasPrice.mul(priorityScaler) };
  }

  async willSucceed(contract: Contract, method: string, args: any) {
    try {
      await contract.callStatic[method](...args);
      return true;
    } catch (_) {
      return false;
    }
  }
}
