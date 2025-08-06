import {
  CompilableTransactionMessage,
  getBase64EncodedWireTransaction,
  KeyPairSigner,
  signTransactionMessageWithSigners,
  TransactionMessageWithBlockhashLifetime,
  setTransactionMessageLifetimeUsingBlockhash,
  setTransactionMessageFeePayer,
  createTransactionMessage,
  appendTransactionMessageInstructions,
  pipe,
  Address,
  fetchEncodedAccount,
  type IInstruction,
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
  getInstructionParamsPda,
  getLatestBlockhash,
  sendAndConfirmSolanaTransaction,
} from "../utils";
import { arch } from "@across-protocol/sdk";
import { SvmSpokeClient } from "@across-protocol/contracts";
import { RelayData } from "../interfaces";

type ProtoFill = Omit<RelayData, "recipient" | "outputToken"> & {
  destinationChainId: number;
  recipient: SvmAddress;
  outputToken: SvmAddress;
};

type ReadyTransactionPromise = Promise<CompilableTransactionMessage & TransactionMessageWithBlockhashLifetime>;
type PrefillInstructionsPromise = Promise<IInstruction[]>;

type QueuedSvmFill = {
  txPromise: ReadyTransactionPromise;
  message: string;
  mrkdwn: string;
};

type MultipartSvmFill = {
  fillRelayPromise: ReadyTransactionPromise;
  prefillInstructions: PrefillInstructionsPromise;
  message: string;
  mrkdwn: string;
};

export class SvmFillerClient {
  private queuedFills: QueuedSvmFill[] = [];
  private queuedMultipartFills: MultipartSvmFill[] = [];
  readonly relayerAddress: SvmAddress;

  private constructor(
    private readonly signer: KeyPairSigner,
    private readonly provider: arch.svm.SVMProvider,
    // @dev Solana mainnet or devnet
    readonly chainId: number,
    readonly instructionParams: Address<string>,
    private readonly logger: winston.Logger
  ) {
    this.relayerAddress = SvmAddress.from(this.signer.address);
  }

  static async from(
    evmSigner: Signer,
    provider: arch.svm.SVMProvider,
    chainId: number,
    spokePool: SDKAddress,
    logger: winston.Logger
  ): Promise<SvmFillerClient> {
    assert(chainIsSvm(chainId));
    const svmSigner = await getKitKeypairFromEvmSigner(evmSigner);
    const instructionParamsPda = await getInstructionParamsPda(arch.svm.toAddress(spokePool), svmSigner.address);
    return new SvmFillerClient(svmSigner, provider, chainId, instructionParamsPda, logger);
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
    // If the message is not empty, then fill via instruction params.
    // @todo We can very small non empty messages, so determine how many bytes the message can be before we do this multipart fill method.
    if (relayData.message !== "0x") {
      const prefillInstructions = arch.svm.getFillRelayViaInstructionParamsInstructions(
        arch.svm.toAddress(spokePool),
        relayData,
        repaymentChainId,
        repaymentAddress,
        this.signer
      );
      const fillRelayPromise = arch.svm.getIPFillRelayTx(
        spokePool,
        this.provider,
        relayData,
        this.signer,
        repaymentChainId,
        repaymentAddress
      );
      this.queuedMultipartFills.push({ fillRelayPromise, prefillInstructions, message, mrkdwn });
      return;
    }
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

  // @dev returns promises with txn signatures (~hashes)
  async executeTxnQueue(chainId: number, simulate = false): Promise<{ hash: string }[]> {
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
        const transaction = await txPromise;
        const signature = await signAndSendTransaction(this.provider, transaction);
        const signatureString = signature.toString();
        signatures.push(signatureString);
        this.logger.info({
          at: "SvmFillerClient#executeTxnQueue",
          message,
          mrkdwn,
          signature: signatureString,
          explorer: blockExplorerLink(signatureString, this.chainId),
        });
      } catch (e) {
        this.logger.error({
          at: "SvmFillerClient#executeTxnQueue",
          message: `Failed to send fill transaction: ${message}`,
          mrkdwn,
          error: e,
        });
      }
    }
    const multipart = this.queuedMultipartFills;
    this.queuedMultipartFills = [];
    if (multipart.length !== 0) {
      const [encodedAccount, recentBlockhash] = await Promise.all([
        fetchEncodedAccount(this.provider, this.instructionParams),
        getLatestBlockhash(this.provider),
      ]);
      const closeInstructionParamsIx = SvmSpokeClient.getCloseInstructionParamsInstruction({
        signer: this.signer,
        instructionParams: this.instructionParams,
      });
      const closeInstructionParamsTx = pipe(
        createTransactionMessage({ version: 0 }),
        (tx) => setTransactionMessageFeePayer(this.signer.address, tx),
        (tx) => setTransactionMessageLifetimeUsingBlockhash(recentBlockhash, tx),
        (tx) => appendTransactionMessageInstructions([closeInstructionParamsIx], tx)
      );
      // If the instruction params account exists, then close it.
      if (encodedAccount.exists) {
        const closeSignature = await sendAndConfirmSolanaTransaction(closeInstructionParamsTx, this.signer, this.provider);
        this.logger.debug({
          at: "SvmFillerClient#executeTxnQueue",
          message: "Closed outstanding instruction params account before executing Solana message relays.",
          closeSignature,
        });
      }
      for (const { fillRelayPromise, prefillInstructions, message, mrkdwn } of multipart) {
        try {
          const [fillTransaction, instructionParamsInstructions] = await Promise.all([
            fillRelayPromise,
            prefillInstructions,
          ]);
          for (const ix of instructionParamsInstructions) {
            // Reuse the same lifetime constraint as given in the fill transaction. Since this is pre-fill transaction, if the fill transaction lifetime is valid, then the pre-fill transactions will also be valid.
            const instructionParamsTx = pipe(
              createTransactionMessage({ version: 0 }),
              (tx) => setTransactionMessageFeePayer(this.signer.address, tx),
              (tx) => setTransactionMessageLifetimeUsingBlockhash(fillTransaction.lifetimeConstraint, tx),
              (tx) => appendTransactionMessageInstructions([ix], tx)
            );
            const prefillSignature = await sendAndConfirmSolanaTransaction(instructionParamsTx, this.signer, this.provider);
            this.logger.debug({
              at: "SvmFillerClient#executeTxnQueue",
              message: "Executed pre-fill instruction params transaction.",
              prefillSignature,
            });
          }
          const signature = await signAndSendTransaction(this.provider, fillTransaction);
          const signatureString = signature.toString();
          signatures.push(signatureString);
          this.logger.info({
            at: "SvmFillerClient#executeTxnQueue",
            message,
            mrkdwn,
            signature: signatureString,
            explorer: blockExplorerLink(signatureString, this.chainId),
          });

          // Close the instruction params PDA so it can be re-initialized on the next loop.
          const closeInstructionParamsTxWithBlockhash = pipe(closeInstructionParamsTx, (tx) =>
            setTransactionMessageLifetimeUsingBlockhash(fillTransaction.lifetimeConstraint, tx)
          );
          const closeSignature = await signAndSendTransaction(this.provider, closeInstructionParamsTxWithBlockhash);
          this.logger.debug({
            at: "SvmFillerClient#executeTxnQueue",
            message: "Closed instruction params after executing a Solana message relay.",
            closeSignature,
          });
        } catch (e) {
          this.logger.error({
            at: "SvmFillerClient#executeTxnQueue",
            message: `Failed to send fill transaction: ${message}`,
            mrkdwn,
            error: e,
          });
        }
      }
    }
    return signatures.map((hash) => ({ hash }));
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  clearTransactionQueue(chainId: number | null = null): void {
    // @dev chainId is ignored because this client only handles one chain. We take `chainId` as arg here to match MulticallerClient interface
    this.queuedFills = [];
    this.queuedMultipartFills = [];
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
    return this.queuedFills.length + this.queuedMultipartFills.length;
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
