import { MultiCallerClient, TransactionClient } from "../../src/clients";
import { Contract, winston } from "../utils";

export class MockedMultiCallerClient extends MultiCallerClient {
  private multisend?: Contract;
  constructor(logger: winston.Logger, chunkSize: { [chainId: number]: number } = {}, multisend?: Contract) {
    super(logger, chunkSize);
    this.txnClient = new TransactionClient(logger);
  }

  // By default return undefined multisender so dataworker can just fallback to calling Multicaller instead
  // of having to deploy a Multisend2 on this network.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async _getMultisender(_: number): Promise<Contract | undefined> {
    return this.multisend;
  }
}
