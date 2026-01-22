import {
  getBase64EncodedWireTransaction,
  isSolanaError,
  KeyPairSigner,
  signTransactionMessageWithSigners,
} from "@solana/kit";
import {
  assert,
  getKitKeypairFromEvmSigner,
  Signer,
  SolanaTransaction,
  SvmAddress,
  Address as SDKAddress,
  blockExplorerLink,
  winston,
  chainIsSvm,
  delay,
  signAndSendTransaction,
  sendAndConfirmSolanaTransaction,
} from "../utils";
import { arch, typeguards } from "@across-protocol/sdk";
import { RelayData } from "../interfaces";

export const SOLANA_TX_SIZE_LIMIT = 1232; // bytes
// Maximum size a message on a deposit can be in order to fill on Solana in a single transaction _and_ have that
// single transaction contain approve and create ATA instructions.
export const MAXIMUM_MESSAGE_SIZE = 466; // string length. equals 466/2-1 = 232 bytes.

type ProtoFill = Omit<RelayData, "recipient" | "outputToken"> & {
  destinationChainId: number;
  recipient: SvmAddress;
  outputToken: SvmAddress;
};

type ReadyTransactionPromise = Promise<SolanaTransaction>;
type ReadyTransactionsPromise = Promise<SolanaTransaction[]>;

type QueuedSvmFill = {
  txPromises: [ReadyTransactionPromise] | [ReadyTransactionsPromise, ReadyTransactionPromise];
  message: string;
  mrkdwn: string;
};

const retryableErrorCodes = [arch.svm.SVM_TRANSACTION_PREFLIGHT_FAILURE];
const retryDelaySeconds = 1;

export class SvmFillerClient {
  private queuedFills: QueuedSvmFill[] = [];
  readonly relayerAddress: SvmAddress;

  private constructor(
    private readonly signer: KeyPairSigner,
    private readonly provider: arch.svm.SVMProvider,
    // @dev Solana mainnet or devnet
    readonly chainId: number,
    private readonly logger: winston.Logger
  ) {
    this.relayerAddress = SvmAddress.from(this.signer.address);
  }

  static async from(
    evmSigner: Signer,
    provider: arch.svm.SVMProvider,
    chainId: number,
    logger: winston.Logger
  ): Promise<SvmFillerClient> {
    assert(chainIsSvm(chainId));
    const svmSigner = await getKitKeypairFromEvmSigner(evmSigner);
    return new SvmFillerClient(svmSigner, provider, chainId, logger);
  }

  enqueueFill(
    spokePool: SvmAddress,
    relayData: ProtoFill,
    repaymentChainId: number,
    repaymentAddress: SDKAddress,
    message: string,
    mrkdwn: string
  ): void {
    assert(
      repaymentAddress.isValidOn(repaymentChainId),
      `SvmFillerClient:enqueueFill ${repaymentAddress} not valid on chain ${repaymentChainId}`
    );
    if (this.isFillMessageTooLarge(relayData)) {
      return this._enqueueMultipartFill(spokePool, relayData, repaymentChainId, repaymentAddress, message, mrkdwn);
    }
    const fillTxPromise = arch.svm.getFillRelayTx(
      spokePool,
      this.provider,
      relayData,
      this.signer,
      repaymentChainId,
      repaymentAddress
    );
    this.queuedFills.push({ txPromises: [fillTxPromise], message, mrkdwn });
  }

  enqueueSlowFill(spokePool: SvmAddress, relayData: ProtoFill, message: string, mrkdwn: string): void {
    const slowFillTxPromise = arch.svm.getSlowFillRequestTx(spokePool, this.provider, relayData, this.signer);
    this.queuedFills.push({ txPromises: [slowFillTxPromise], message, mrkdwn });
  }

  private _enqueueMultipartFill(
    spokePool: SvmAddress,
    relayData: ProtoFill,
    repaymentChainId: number,
    repaymentAddress: SDKAddress,
    message: string,
    mrkdwn: string
  ): void {
    const ipTxsPromise = arch.svm.getIPForFillRelayTxs(
      spokePool,
      relayData,
      repaymentChainId,
      repaymentAddress,
      this.signer,
      this.provider
    );
    const fillTxPromise = arch.svm.getIPFillRelayTx(
      spokePool,
      this.provider,
      relayData,
      this.signer,
      repaymentChainId,
      repaymentAddress
    );
    this.queuedFills.push({ txPromises: [ipTxsPromise, fillTxPromise], message, mrkdwn });
  }

  async _executeTxnQueueWithRetry(
    txPromises: (ReadyTransactionPromise | ReadyTransactionsPromise)[],
    retryAttempt: number
  ): Promise<string[]> {
    try {
      const transactions = await Promise.all(txPromises);
      const signatures = [];
      const transactionBatch = transactions.flat(); // Cast a single transaction or batch into an array.
      const sendAndConfirm = transactionBatch.length !== 1;

      // Ordering of the transactions must be preserved.
      for (const transaction of transactionBatch) {
        const txSignature = sendAndConfirm
          ? sendAndConfirmSolanaTransaction(transaction, this.provider)
          : signAndSendTransaction(this.provider, transaction);
        signatures.push(await txSignature);
      }
      return signatures;
    } catch (e: unknown) {
      let code: number | undefined;

      if (isSolanaError(e)) {
        code = e.context.__code;
      } else {
        code = undefined;
      }

      if (retryableErrorCodes.includes(code) && retryAttempt > 0) {
        await delay(retryDelaySeconds);
        return this._executeTxnQueueWithRetry(txPromises, --retryAttempt);
      }

      throw e;
    }
  }

  // @dev returns promises with txn signatures (~hashes)
  async executeTxnQueue(chainId: number, simulate = false, maxRetries = 2): Promise<{ hash: string }[]> {
    assert(this.chainId === chainId, "SvmFillerClient: Mismatched chainId");
    const queue = this.queuedFills;
    this.queuedFills = [];

    if (simulate) {
      await this.simulateQueue(queue);
      return [];
    }

    // @dev Execute transactions sequentially, returning signatures of successful ones.
    const signatures: string[][] = [];
    for (const { txPromises, message, mrkdwn } of queue) {
      try {
        const signatureStrings = await this._executeTxnQueueWithRetry(txPromises, maxRetries);
        this.logger.info({
          at: "SvmFillerClient#executeTxnQueue",
          message,
          mrkdwn,
          signatures: signatureStrings,
          explorer: blockExplorerLink(signatureStrings.at(-1), this.chainId),
        });
        signatures.push(signatureStrings);
      } catch (e: unknown) {
        if (!typeguards.isError(e)) {
          throw e;
        }

        let message = "";
        if (!isSolanaError(e)) {
          message = e?.message ?? "Unknown error";
        } else {
          message = `Solana error code: ${e.context.__code}`;
        }

        this.logger.error({
          at: "SvmFillerClient#executeTxnQueue",
          message: `Failed to send fill transaction (${message})`,
          mrkdwn,
          error: e,
        });
      }
    }
    return signatures.flat().map((hash) => ({ hash }));
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  clearTransactionQueue(chainId: number | null = null): void {
    // @dev chainId is ignored because this client only handles one chain. We take `chainId` as arg here to match MulticallerClient interface
    this.queuedFills = [];
  }

  // @dev simulates all transactions from the queue in parallel, logging their results
  private async simulateQueue(_queue: QueuedSvmFill[]) {
    // It is not possible to simulate a multipart fill, so if we have one in the queue, then skip it.
    const queue = _queue.filter(({ txPromises }) => txPromises.length === 1);
    const nMultipart = _queue.length - queue.length;

    if (nMultipart > 0) {
      this.logger.debug({
        at: "SvmFillerClient#simulateQueue",
        message: `Cannot simulate ${nMultipart} multipart transaction(s).`,
      });
    }

    if (queue.length === 0) {
      return;
    }

    const simulationResults = await Promise.allSettled(
      queue.map(({ txPromises }) => txPromises[0].then((tx) => signAndSimulateTransaction(this.provider, tx)))
    );

    const successfulSims: { logs: string[]; message: string; mrkdwn: string }[] = [];
    const failedSims: { error: any; message: string; mrkdwn: string }[] = [];

    simulationResults.forEach((result, idx) => {
      const { message, mrkdwn } = queue[idx];
      if (result.status === "fulfilled") {
        const simValue = result.value.value;
        if (simValue.err === null) {
          successfulSims.push({ logs: simValue.logs, message, mrkdwn });
        } else {
          failedSims.push({ error: simValue.err, message, mrkdwn });
        }
      } else {
        failedSims.push({ error: result.reason, message, mrkdwn });
      }
    });

    if (failedSims.length > 0) {
      this.logger.error({
        at: "SvmFillerClient#simulateQueue",
        message: `${failedSims.length}/${queue.length} simulations failed.`,
        errors: failedSims.map((f) => `${String(f.error)}\n${f.message}\n${f.mrkdwn}`).join("\n\n"),
        notificationPath: "across-error",
      });
    }

    if (successfulSims.length > 0) {
      this.logger.info({
        at: "SvmFillerClient#simulateQueue",
        message: `Successfully simulated ${successfulSims.length}/${queue.length} transactions.`,
        auxiliary: successfulSims.map((s) => `${s.message}\n${s.mrkdwn}`).join("\n\n"),
      });
    }
  }

  getTxnQueueLen(): number {
    return this.queuedFills.length;
  }

  // Approximation since we cannot asynchronously compute the fillRelay tx when assigning this deposit to
  // a fill or multipart fill queue.
  // This function will not be exact when the recipient has an ATA on Solana, in which case it overestimates the
  // size of the transaction.
  isFillMessageTooLarge(relayData: Pick<ProtoFill, "message">): boolean {
    // Assuming a fill which contains the approve and createAta instructions in the transaction, the maximum message size
    // is SOLANA_TX_SIZE_LIMIT - MAXIMUM_MESSAGE_SIZE.
    return relayData.message.length > MAXIMUM_MESSAGE_SIZE;
  }
}

const signAndSimulateTransaction = async (provider: arch.svm.SVMProvider, unsignedTxn: arch.svm.SolanaTransaction) => {
  const signedTransaction = await signTransactionMessageWithSigners(unsignedTxn);
  const serializedTx = getBase64EncodedWireTransaction(signedTransaction);
  return provider
    .simulateTransaction(
      serializedTx,
      // @dev adapted config from https://solana.com/docs/rpc/http/simulatetransaction
      {
        sigVerify: false,
        replaceRecentBlockhash: true,
        commitment: "finalized",
        encoding: "base64",
      }
    )
    .send();
};
