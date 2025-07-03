import {
  CompilableTransactionMessage,
  getBase64EncodedWireTransaction,
  KeyPairSigner,
  signTransactionMessageWithSigners,
  TransactionMessageWithBlockhashLifetime,
  type TransactionSigner,
} from "@solana/kit";
import {
  assert,
  getKitKeypairFromEvmSigner,
  Signer,
  SvmAddress,
  Address as SDKAddress,
  blockExplorerLink,
  winston,
} from "../utils";
import { arch } from "@across-protocol/sdk";
import { RelayData } from "../interfaces";
import { chainIsSvm } from "@across-protocol/sdk/dist/types/utils";

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

export class SvmFillerClient {
  private readonly logger: winston.Logger;
  private readonly provider: arch.svm.SVMProvider;
  // @dev Solana mainnet or devnet
  readonly chainId: number;
  private readonly signer: TransactionSigner;
  private queuedFills: QueuedSvmFill[] = [];

  private constructor(signer: KeyPairSigner, provider: arch.svm.SVMProvider, chainId: number, logger: winston.Logger) {
    this.signer = signer;
    this.provider = provider;
    this.chainId = chainId;
    this.logger = logger;
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
  ) {
    assert(
      repaymentAddress.isValidOn(repaymentChainId),
      `SvmFillerClient:enqueueFill ${repaymentAddress} not valid on chain ${repaymentChainId}`
    );
    const fillTx = arch.svm.getFillRelayTx(
      spokePool,
      this.provider,
      relayData,
      this.signer,
      repaymentChainId,
      repaymentAddress
    );
    this.queuedFills.push({ txPromise: fillTx, message, mrkdwn });
  }

  enqueueSlowFill(relayData: ProtoFill) {
    // todo: implement similarly to `enqueueFill`
    assert(false, "SvmFillerClient.enqueueSlowFill not implemented");
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

    // @dev execture transactions consecutively, returning signatures of successful ones
    const signatures = await queue.reduce(async (acc, { txPromise, message, mrkdwn }) => {
      const signatures = await acc;
      try {
        const transaction = await txPromise;
        const signature = await signAndSendTransaction(this.provider, transaction);
        signatures.push(signature.toString());
        this.logger.info({
          at: "SvmFillerClient#executeTxnQueue",
          message,
          mrkdwn,
          signature: signature.toString(),
          explorer: blockExplorerLink(signature.toString(), this.chainId),
        });
      } catch (e) {
        this.logger.warn({
          at: "SvmFillerClient#executeTxnQueue",
          message: `Failed to send fill transaction: ${message}`,
          mrkdwn,
          error: e,
        });
      }
      return signatures;
    }, Promise.resolve([] as string[]));
    return signatures.map((hash) => ({ hash }));
  }

  // @dev chainId is here to match MulticallerClient interface
  clearTransactionQueue(chainId: number | null = null): void {
    // NOTE: chainId is ignored because this client only handles one chain.
    this.queuedFills = [];
  }

  // @dev simulates all transactions from the queue, logging their results
  private async simulateQueue(queue: QueuedSvmFill[]) {
    if (queue.length === 0) return;

    const simulationResults = await Promise.allSettled(
      queue.map(({ txPromise }) => txPromise.then((tx) => signAndSimulateTransaction(this.provider, tx)))
    );

    const successfulSims: { logs: string[] | null }[] = [];
    const failedSims: { error: any }[] = [];

    simulationResults.forEach((result) => {
      if (result.status === "fulfilled") {
        const simValue = result.value.value;
        if (simValue.err === null) {
          successfulSims.push({ logs: simValue.logs });
        } else {
          failedSims.push({ error: simValue.err });
        }
      } else {
        failedSims.push({ error: result.reason });
      }
    });

    if (failedSims.length > 0) {
      this.logger.error({
        at: "SvmFillerClient#simulateQueue",
        message: `${failedSims.length}/${queue.length} simulations failed.`,
        errors: failedSims.map((f) => f.error),
        notificationPath: "across-error",
      });
    }

    if (successfulSims.length > 0) {
      this.logger.info({
        at: "SvmFillerClient#simulateQueue",
        message: `Successfully simulated ${successfulSims.length}/${queue.length} transactions.`,
      });
    }
  }

  getTxnQueueLen(): number {
    return this.queuedFills.length;
  }

  getRelayerAddr(): SvmAddress {
    return SvmAddress.from(this.signer.address);
  }
}

const signAndSendTransaction = async (
  provider: arch.svm.SVMProvider,
  unsignedTxn: CompilableTransactionMessage & TransactionMessageWithBlockhashLifetime
) => {
  const signedTransaction = await signTransactionMessageWithSigners(unsignedTxn);
  const serializedTx = getBase64EncodedWireTransaction(signedTransaction);
  return provider.sendTransaction(serializedTx).send();
};

const signAndSimulateTransaction = async (
  provider: arch.svm.SVMProvider,
  unsignedTxn: CompilableTransactionMessage & TransactionMessageWithBlockhashLifetime
) => {
  const signedTransaction = await signTransactionMessageWithSigners(unsignedTxn);
  const serializedTx = getBase64EncodedWireTransaction(signedTransaction);
  // @dev adapted config from https://solana.com/docs/rpc/http/simulatetransaction
  const simulateTxConfig = {
    sigVerify: false,
    replaceRecentBlockhash: true,
    commitment: "finalized",
    encoding: "base64",
  } as const;
  return provider.simulateTransaction(serializedTx, simulateTxConfig).send();
};
