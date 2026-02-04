import { gasPriceOracle, typeguards, utils as sdkUtils } from "@across-protocol/sdk";
import { FeeData } from "@ethersproject/abstract-provider";
import dotenv from "dotenv";
import { AugmentedTransaction, TransactionClient } from "../clients";
import {
  Contract,
  isDefined,
  TransactionResponse,
  ethers,
  getContractInfoFromAddress,
  Signer,
  SolanaTransaction,
  toBNWei,
  SVMProvider,
  parseUnits,
} from "../utils";
import { getBase64EncodedWireTransaction, signTransactionMessageWithSigners, type MicroLamports } from "@solana/kit";
import { updateOrAppendSetComputeUnitPriceInstruction } from "@solana-program/compute-budget";

dotenv.config();


export type TransactionSimulationResult = {
  transaction: AugmentedTransaction;
  succeed: boolean;
  reason?: string;
  data?: any;
};

export type Multicall2Call = {
  callData: ethers.utils.BytesLike;
  target: string;
};

export function getMultisender(chainId: number, baseSigner: Signer): Contract | undefined {
  return sdkUtils.getMulticall3(chainId, baseSigner);
}

export async function signAndSendTransaction(provider: SVMProvider, _unsignedTxn: SolanaTransaction) {
  const priorityFeeOverride = process.env["SVM_PRIORITY_FEE_OVERRIDE"];
  const unsignedTxn = isDefined(priorityFeeOverride)
    ? updateOrAppendSetComputeUnitPriceInstruction(BigInt(priorityFeeOverride) as MicroLamports, _unsignedTxn)
    : _unsignedTxn;
  const signedTransaction = await signTransactionMessageWithSigners(unsignedTxn);
  const serializedTx = getBase64EncodedWireTransaction(signedTransaction);
  return provider
    .sendTransaction(serializedTx, { preflightCommitment: "confirmed", skipPreflight: false, encoding: "base64" })
    .send();
}

export async function sendAndConfirmSolanaTransaction(
  unsignedTransaction: SolanaTransaction,
  provider: SVMProvider,
  cycles = 25,
  pollingDelay = 600 // 1.5 slots on Solana.
): Promise<string> {
  const delay = (ms: number) => {
    return new Promise((resolve) => setTimeout(resolve, ms));
  };
  const txSignature = await signAndSendTransaction(provider, unsignedTransaction);
  let confirmed = false;
  let _cycles = 0;
  while (!confirmed && _cycles < cycles) {
    const txStatus = await provider.getSignatureStatuses([txSignature]).send();
    // Index 0 since we are only sending a single transaction in this method.
    confirmed =
      txStatus?.value?.[0]?.confirmationStatus === "confirmed" ||
      txStatus?.value?.[0]?.confirmationStatus === "finalized";
    // If the transaction wasn't confirmed, wait `pollingInterval` and retry.
    if (!confirmed) {
      await delay(pollingDelay);
      _cycles++;
    }
  }
  return txSignature;
}

export async function simulateSolanaTransaction(unsignedTransaction: SolanaTransaction, provider: SVMProvider) {
  const signedTx = await signTransactionMessageWithSigners(unsignedTransaction);
  const serializedTx = getBase64EncodedWireTransaction(signedTx);
  return provider.simulateTransaction(serializedTx, { sigVerify: false, encoding: "base64" }).send();
}

export async function getGasPrice(
  provider: ethers.providers.Provider,
  priorityScaler = 1.2,
  maxFeePerGasScaler = 3,
  transactionObject?: ethers.PopulatedTransaction
): Promise<Pick<FeeData, "maxFeePerGas" | "maxPriorityFeePerGas">> {
  const { chainId } = await provider.getNetwork();

  const maxFee = process.env[`MAX_FEE_PER_GAS_OVERRIDE_${chainId}`];
  const priorityFee = process.env[`MAX_PRIORITY_FEE_PER_GAS_OVERRIDE_${chainId}`];
  if (isDefined(maxFee) && isDefined(priorityFee)) {
    return {
      maxFeePerGas: parseUnits(maxFee, 9),
      maxPriorityFeePerGas: parseUnits(priorityFee, 9),
    };
  }

  // Floor scalers at 1.0 as we'll rarely want to submit too low of a gas price. We mostly
  // just want to submit with as close to prevailing fees as possible.
  maxFeePerGasScaler = Math.max(1, maxFeePerGasScaler);
  priorityScaler = Math.max(1, priorityScaler);

  // Linea gas price estimation requires transaction simulation so supply the unsigned transaction.
  const feeData = await gasPriceOracle.getGasPriceEstimate(provider, {
    chainId,
    baseFeeMultiplier: toBNWei(maxFeePerGasScaler),
    priorityFeeMultiplier: toBNWei(priorityScaler),
    unsignedTx: transactionObject,
  });

  // Default to EIP-1559 (type 2) pricing. If gasPriceOracle is using a legacy adapter for this chain then
  // the priority fee will be 0.
  return {
    maxFeePerGas: feeData.maxFeePerGas,
    maxPriorityFeePerGas: feeData.maxPriorityFeePerGas,
  };
}

export async function willSucceed(transaction: AugmentedTransaction): Promise<TransactionSimulationResult> {
  // If the transaction already has a gasLimit, it should have been simulated in advance.
  if (transaction.canFailInSimulation || isDefined(transaction.gasLimit)) {
    return { transaction, succeed: true };
  }

  const { contract, method } = transaction;
  const args = transaction.value ? [...transaction.args, { value: transaction.value }] : transaction.args;

  // First callStatic, which will surface a custom error if the transaction would fail.
  // This is useful for surfacing custom error revert reasons like RelayFilled in the SpokePool but
  // it does incur an extra RPC call. We do this because estimateGas is a provider function that doesn't
  // relay custom errors well: https://github.com/ethers-io/ethers.js/discussions/3291#discussion-4314795
  let data;
  try {
    data = await contract.callStatic[method](...args);
  } catch (err: any) {
    if (err.errorName) {
      return {
        transaction,
        succeed: false,
        reason: err.errorName,
      };
    }
  }

  try {
    const gasLimit = await contract.estimateGas[method](...args);
    return { transaction: { ...transaction, gasLimit }, succeed: true, data };
  } catch (error) {
    const reason = typeguards.isEthersError(error) ? error.reason : "unknown error";
    return { transaction, succeed: false, reason };
  }
}

export function getTarget(targetAddress: string):
  | {
      chainId: number;
      contractName: string;
      targetAddress: string;
    }
  | {
      targetAddress: string;
    } {
  try {
    return { targetAddress, ...getContractInfoFromAddress(targetAddress) };
  } catch (error) {
    return { targetAddress };
  }
}


export async function submitTransaction(
  transaction: AugmentedTransaction,
  transactionClient: TransactionClient
): Promise<TransactionResponse> {
  const { reason, succeed, transaction: txnRequest } = (await transactionClient.simulate([transaction]))[0];
  const { contract: targetContract, method, ...txnRequestData } = txnRequest;
  if (!succeed) {
    const message = `Failed to simulate ${targetContract.address}.${method}(${txnRequestData.args.join(", ")}) on ${
      txnRequest.chainId
    }`;
    throw new Error(`${message} (${reason})`);
  }

  const response = await transactionClient.submit(transaction.chainId, [transaction]);
  if (response.length === 0) {
    throw new Error(
      `Transaction succeeded simulation but failed to submit onchain to ${
        targetContract.address
      }.${method}(${txnRequestData.args.join(", ")}) on ${txnRequest.chainId}`
    );
  }
  return response[0];
}
