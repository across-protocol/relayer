import {
    AugmentedTransaction,
    MultiCallerClient
  } from "../../src/clients";
  import { TransactionSimulationResult } from "../../src/utils";
  import { MockedTransactionClient } from "./MockTransactionClient";
  import {
    Contract,
    winston,
  } from "../utils";
  
export class MockedMultiCallerClient extends MultiCallerClient {
    public ignoredSimulationFailures: TransactionSimulationResult[] = [];
    public loggedSimulationFailures: TransactionSimulationResult[] = [];
  
    constructor(logger: winston.Logger, chunkSize: { [chainId: number]: number } = {}, public multisend?: Contract) {
      super(logger, chunkSize);
      this.txnClient = new MockedTransactionClient(logger);
    }
  
    simulationFailureCount(): number {
      return this.loggedSimulationFailures.length + this.ignoredSimulationFailures.length;
    }
  
    clearSimulationFailures(): void {
      this.ignoredSimulationFailures = [];
      this.loggedSimulationFailures = [];
    }
  
    private txnCount(txnQueue: { [chainId: number]: AugmentedTransaction[] }): number {
      return Object.values(txnQueue).reduce((count, txnQueue) => (count += txnQueue.length), 0);
    }
  
    async _getMultisender(_: any): Promise<Contract | undefined> {
      return this.multisend;
    }
  
    valueTxnCount(): number {
      return this.txnCount(this.valueTxns);
    }
  
    multiCallTransactionCount(): number {
      return this.txnCount(this.txns);
    }
  
    protected override logSimulationFailures(txns: TransactionSimulationResult[]): void {
      this.clearSimulationFailures();
      txns.forEach((txn) => {
        (this.canIgnoreRevertReason(txn) ? this.ignoredSimulationFailures : this.loggedSimulationFailures).push(txn);
      });
    }
  }