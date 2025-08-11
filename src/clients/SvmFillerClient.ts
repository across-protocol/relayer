import {
  CompilableTransactionMessage,
  getBase64EncodedWireTransaction,
  isSolanaError,
  KeyPairSigner,
  signTransactionMessageWithSigners,
  TransactionMessageWithBlockhashLifetime,
} from "@solana/kit";
import {
  assert,
  getKitKeypairFromEvmSigner,
  Signer,
  SvmAddress,
  Address as SDKAddress,
  blockExplorerLink,
  winston,
  chainIsSvm,
  delay,
} from "../utils";
import { arch, typeguards } from "@across-protocol/sdk";
import { RelayData } from "../interfaces";

type ProtoFill = Omit<RelayData, "recipient" | "outputToken"> & {
  destinationChainId: number;
  recipient: SvmAddress;
  outputToken: SvmAddress;
};

type ReadyTransactionPromise = Promise<CompilableTransactionMessage & TransactionMessageWithBlockhashLifetime>;

type QueuedSvmFill = {
  txPromise: ReadyTransactionPromise;
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
    const fillTxPromise = arch.svm.getFillRelayTx(
      spokePool,
      this.provider,
      relayData,
      this.signer,
      repaymentChainId,
      repaymentAddress
    );
    this.queuedFills.push({ txPromise: fillTxPromise, message, mrkdwn });
  }

  enqueueSlowFill(spokePool: SvmAddress, relayData: ProtoFill, message: string, mrkdwn: string): void {
    const slowFillTxPromise = arch.svm.getSlowFillRequestTx(spokePool, this.provider, relayData, this.signer);
    this.queuedFills.push({ txPromise: slowFillTxPromise, message, mrkdwn });
  }

  async _executeTxnQueueWithRetry(txPromise: ReadyTransactionPromise, retryAttempt: number): Promise<string> {
    try {
      const transaction = await txPromise;
      const signature = await signAndSendTransaction(this.provider, transaction);
      const signatureString = signature.toString();
      return signatureString;
    } catch (e: unknown) {
      let code: number | undefined;

      if (isSolanaError(e)) {
        code = e.context.__code;
      } else {
        code = undefined;
      }

      if (retryableErrorCodes.includes(code) && retryAttempt > 0) {
        await delay(retryDelaySeconds);
        return this._executeTxnQueueWithRetry(txPromise, --retryAttempt);
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
    const signatures: string[] = [];
    for (const { txPromise, message, mrkdwn } of queue) {
      try {
        const signatureString = await this._executeTxnQueueWithRetry(txPromise, maxRetries);
        signatures.push(signatureString);
        this.logger.info({
          at: "SvmFillerClient#executeTxnQueue",
          message,
          mrkdwn,
          signature: signatureString,
          explorer: blockExplorerLink(signatureString, this.chainId),
        });
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
    return signatures.map((hash) => ({ hash }));
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  clearTransactionQueue(chainId: number | null = null): void {
    // @dev chainId is ignored because this client only handles one chain. We take `chainId` as arg here to match MulticallerClient interface
    this.queuedFills = [];
  }

  // @dev simulates all transactions from the queue in parallel, logging their results
  private async simulateQueue(queue: QueuedSvmFill[]) {
    if (queue.length === 0) {
      return;
    }

    const simulationResults = await Promise.allSettled(
      queue.map(({ txPromise }) => txPromise.then((tx) => signAndSimulateTransaction(this.provider, tx)))
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
}

const signAndSendTransaction = async (
  provider: arch.svm.SVMProvider,
  unsignedTxn: CompilableTransactionMessage & TransactionMessageWithBlockhashLifetime
) => {
  const signedTransaction = await signTransactionMessageWithSigners(unsignedTxn);
  const serializedTx = getBase64EncodedWireTransaction(signedTransaction);
  return provider
    .sendTransaction(serializedTx, { preflightCommitment: "confirmed", skipPreflight: false, encoding: "base64" })
    .send();
};

const signAndSimulateTransaction = async (
  provider: arch.svm.SVMProvider,
  unsignedTxn: CompilableTransactionMessage & TransactionMessageWithBlockhashLifetime
) => {
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
