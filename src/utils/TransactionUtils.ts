import { gasPriceOracle, typeguards, utils as sdkUtils } from "@across-protocol/sdk";
import { FeeData } from "@ethersproject/abstract-provider";
import dotenv from "dotenv";
import { AugmentedTransaction } from "../clients";
import { DEFAULT_GAS_FEE_SCALERS } from "../common";
import { EthersError } from "../interfaces";
import {
  BigNumber,
  bnZero,
  Contract,
  isDefined,
  fixedPointAdjustment,
  TransactionResponse,
  ethers,
  getContractInfoFromAddress,
  Signer,
  toBNWei,
  winston,
  CHAIN_IDs,
  SVMProvider,
  parseUnits,
} from "../utils";
import {
  CompilableTransactionMessage,
  KeyPairSigner,
  getBase64EncodedWireTransaction,
  signTransactionMessageWithSigners,
  type Blockhash,
} from "@solana/kit";

dotenv.config();

// Define chains that require legacy (type 0) transactions
export const LEGACY_TRANSACTION_CHAINS = [CHAIN_IDs.BSC];

export type TransactionSimulationResult = {
  transaction: AugmentedTransaction;
  succeed: boolean;
  reason?: string;
  data?: any;
};

export type LatestBlockhash = {
  blockhash: Blockhash;
  lastValidBlockHeight: bigint;
};

const { isError, isEthersError } = typeguards;

export type Multicall2Call = {
  callData: ethers.utils.BytesLike;
  target: string;
};

const nonceReset: { [chainId: number]: boolean } = {};

export function getNetworkError(err: unknown): string {
  return isEthersError(err) ? err.reason : isError(err) ? err.message : "unknown error";
}

export async function getMultisender(chainId: number, baseSigner: Signer): Promise<Contract | undefined> {
  return sdkUtils.getMulticall3(chainId, baseSigner);
}

// Note that this function will throw if the call to the contract on method for given args reverts. Implementers
// of this method should be considerate of this and catch the response to deal with the error accordingly.
// @dev: If the method value is an empty string (e.g. ""), then this function
// will submit a raw transaction to the contract address.
export async function runTransaction(
  logger: winston.Logger,
  contract: Contract,
  method: string,
  args: unknown,
  value = bnZero,
  gasLimit: BigNumber | null = null,
  nonce: number | null = null,
  retries = 2,
  bumpGas = false
): Promise<TransactionResponse> {
  const at = "TxUtil#runTransaction";
  const { provider, signer } = contract;
  const { chainId } = await provider.getNetwork();

  if (!nonce || !nonceReset[chainId]) {
    nonce = await provider.getTransactionCount(await signer.getAddress());
    nonceReset[chainId] = true;
  }

  const sendRawTxn = method === "";
  const priorityFeeScaler =
    Number(process.env[`PRIORITY_FEE_SCALER_${chainId}`] || process.env.PRIORITY_FEE_SCALER) ||
    DEFAULT_GAS_FEE_SCALERS[chainId]?.maxPriorityFeePerGasScaler;
  const maxFeePerGasScaler =
    Number(process.env[`MAX_FEE_PER_GAS_SCALER_${chainId}`] || process.env.MAX_FEE_PER_GAS_SCALER) ||
    DEFAULT_GAS_FEE_SCALERS[chainId]?.maxFeePerGasScaler;

  // Probably want to wrap getGasPRice() in a try/catch + retry in a follow-up change.
  const gas = await getGasPrice(
    provider,
    priorityFeeScaler,
    maxFeePerGasScaler,
    sendRawTxn ? undefined : await contract.populateTransaction[method](...(args as Array<unknown>), { value })
  );
  const gasScaler = toBNWei(bumpGas ? maxFeePerGasScaler : 1);
  const scaledGas = scaleGasPrice(chainId, gas, gasScaler);

  const to = contract.address;
  const commonArgs = { chainId, to, method, args, nonce, gas: scaledGas, gasLimit, sendRawTxn };
  logger.debug({ at, message: "Submitting transaction", ...commonArgs });

  // TX config has gas (from gasPrice function), value (how much eth to send) and an optional gasLimit. The reduce
  // operation below deletes any null/undefined elements from this object. If gasLimit or nonce are not specified,
  // ethers will determine the correct values to use.
  const txConfig = Object.entries({ ...scaledGas, value, nonce, gasLimit }).reduce(
    (a, [k, v]) => (v ? ((a[k] = v), a) : a),
    {}
  );

  try {
    return sendRawTxn
      ? await signer.sendTransaction({ to, value, ...scaledGas })
      : await contract[method](...(args as Array<unknown>), txConfig);
  } catch (error: unknown) {
    // Narrow type. All errors caught here should be Ethers errors.
    if (!typeguards.isEthersError(error)) {
      throw error;
    }

    const { errors } = ethers;
    const { code } = error;
    switch (code) {
      // Transaction fails on simulation; escalate this to the upper layers for context-appropriate handling.
      case errors.UNPREDICTABLE_GAS_LIMIT:
        throw error;

      // Nonce collisions, likely due to concurrent bot instances running. Re-sync nonce and retry.
      case errors.NONCE_EXPIRED: // fallthrough
      case errors.TRANSACTION_REPLACED:
        nonce = null;
        break;

      // Pending transactions in the mempool (likely underpriced). Bump gas and try to replace.
      case errors.REPLACEMENT_UNDERPRICED:
        bumpGas = true;
        --retries;
        break;

      // Transient provider issue; retry.
      case errors.SERVER_ERROR: // fallthrough
      case errors.TIMEOUT:
        --retries;
        break;

      // Bad errors - likely something wrong in the codebase.
      case errors.INVALID_ARGUMENT: // fallthrough
      case errors.MISSING_ARGUMENT: // fallthrough
      case errors.UNEXPECTED_ARGUMENT: {
        const message = "Attempted to submit invalid transaction ethers error on transaction submission.";
        logger.warn({ at, code, message, ...commonArgs });
        throw error;
      }

      default:
        logger.warn({ at, message: `Unhandled error on transaction submission: ${code}.`, ...commonArgs });
        --retries;
    }

    return await runTransaction(logger, contract, method, args, value, gasLimit, nonce, retries, bumpGas);
  }
}

export async function sendAndConfirmSolanaTransaction(
  unsignedTransaction: CompilableTransactionMessage,
  signer: KeyPairSigner,
  provider: SVMProvider,
  cycles = 25,
  pollingDelay = 600 // 1.5 slots on Solana.
): Promise<string> {
  const delay = (ms: number) => {
    return new Promise((resolve) => setTimeout(resolve, ms));
  };
  const signedTx = await signTransactionMessageWithSigners(unsignedTransaction);
  const serializedTx = getBase64EncodedWireTransaction(signedTx);
  const txSignature = await provider
    .sendTransaction(serializedTx, { preflightCommitment: "confirmed", skipPreflight: false, encoding: "base64" })
    .send();
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

export async function getGasPrice(
  provider: ethers.providers.Provider,
  priorityScaler = 1.2,
  maxFeePerGasScaler = 3,
  transactionObject?: ethers.PopulatedTransaction
): Promise<Pick<FeeData, "maxFeePerGas" | "maxPriorityFeePerGas">> {
  const { chainId } = await provider.getNetwork();

  // Pass in unsignedTx here for better Linea gas price estimations via the Linea Viem provider.
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
  } catch (_error) {
    const error = _error as EthersError;
    return { transaction, succeed: false, reason: error.reason };
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

/**
 * Apply local scaling to a gas price. The gas price can be scaled up in case it falls beneath an env-defined
 * price floor, or in case of a retry (i.e. due to replacement underpriced RPC rejection).
 * @param chainId Chain ID for transaction submission.
 * @param gas Input gas price (Legacy/type 0 or eip1559/type 2).
 * @param scaler Multiplier to apply to the gas price.
 * @returns A scaled type 0 or type 2 gas price, dependent on chainId.
 */
function scaleGasPrice(
  chainId: number,
  gas: Pick<FeeData, "maxFeePerGas" | "maxPriorityFeePerGas">,
  retryScaler: BigNumber
): Pick<FeeData, "maxFeePerGas" | "maxPriorityFeePerGas"> | Pick<FeeData, "gasPrice"> {
  const flooredPriorityFeePerGas = parseUnits(process.env[`MIN_PRIORITY_FEE_PER_GAS_${chainId}`] || "0", 9);

  // Check if the chain requires legacy transactions
  if (LEGACY_TRANSACTION_CHAINS.includes(chainId)) {
    const gasPrice = sdkUtils
      .bnMax(gas.maxFeePerGas, flooredPriorityFeePerGas)
      .mul(retryScaler)
      .div(fixedPointAdjustment);
    return { gasPrice };
  }

  // If the priority fee was increased, the max fee must be scaled up as well.
  const maxPriorityFeePerGas = sdkUtils
    .bnMax(gas.maxPriorityFeePerGas, flooredPriorityFeePerGas)
    .mul(retryScaler)
    .div(fixedPointAdjustment);
  const maxFeeDelta = maxPriorityFeePerGas.sub(gas.maxPriorityFeePerGas);

  return {
    maxFeePerGas: gas.maxFeePerGas.add(maxFeeDelta),
    maxPriorityFeePerGas,
  };
}
