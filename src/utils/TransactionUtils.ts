import { gasPriceOracle, providers as sdkProviders, typeguards, utils as sdkUtils } from "@across-protocol/sdk";
import { FeeData } from "@ethersproject/abstract-provider";
import dotenv from "dotenv";
import { AugmentedTransaction } from "../clients";
import { DEFAULT_GAS_FEE_SCALERS } from "../common";
import {
  BigNumber,
  bnZero,
  Contract,
  delay,
  isDefined,
  fixedPointAdjustment,
  TransactionResponse,
  ethers,
  getContractInfoFromAddress,
  getNetworkName,
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

// Maximum multiplier applied on transaction retries due to REPLACEMENT_UNDERPRICED.
const MAX_GAS_RETRY_SCALER = 3;

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

export type Multicall2Call = {
  callData: ethers.utils.BytesLike;
  target: string;
};

export async function getMultisender(chainId: number, baseSigner: Signer): Promise<Contract | undefined> {
  return sdkUtils.getMulticall3(chainId, baseSigner);
}

// This function will throw if the call to the transaction reverts.
// Callers should catch this response to deal with the error accordingly.
// @dev: If the method value is an empty string (i.e. ""), then this function will submit a raw transaction.
export async function runTransaction(
  logger: winston.Logger,
  contract: Contract,
  method: string,
  args: unknown,
  value = bnZero,
  gasLimit: BigNumber | null = null,
  nonce: number | null = null,
  retries = 2,
  gasScaler = 1.0
): Promise<TransactionResponse> {
  const at = "TxUtil#runTransaction";
  const { provider, signer } = contract;
  const { chainId } = await provider.getNetwork();
  const chain = getNetworkName(chainId);
  const sendRawTxn = method === "";

  const priorityFeeScaler =
    Number(process.env[`PRIORITY_FEE_SCALER_${chainId}`] || process.env.PRIORITY_FEE_SCALER) ||
    DEFAULT_GAS_FEE_SCALERS[chainId]?.maxPriorityFeePerGasScaler;
  const maxFeePerGasScaler =
    Number(process.env[`MAX_FEE_PER_GAS_SCALER_${chainId}`] || process.env.MAX_FEE_PER_GAS_SCALER) ||
    DEFAULT_GAS_FEE_SCALERS[chainId]?.maxFeePerGasScaler;

  let gas: Partial<FeeData>;
  try {
    nonce ??= await provider.getTransactionCount(await signer.getAddress());
    const preGas = await getGasPrice(
      provider,
      priorityFeeScaler,
      maxFeePerGasScaler,
      sendRawTxn ? undefined : await contract.populateTransaction[method](...(args as Array<unknown>), { value })
    );
    gas = scaleGasPrice(chainId, preGas, gasScaler);
  } catch (error) {
    // Linea uses linea_estimateGas and will throw on FilledRelay() reverts; skip retries.
    // nb. Requiring low-level chain & method inspection is a wart on the implementation. @todo: refactor it away.
    if ((chainId === CHAIN_IDs.LINEA && method === "fillRelay") || --retries < 0) {
      throw error;
    }
    return await runTransaction(logger, contract, method, args, value, gasLimit, nonce, retries);
  }

  const to = contract.address;
  const commonFields = { chainId, to, method, args, value, nonce, gas, gasLimit, sendRawTxn };
  logger.debug({ at, message: "Submitting transaction.", ...commonFields });

  // TX config has gas (from gasPrice function), value (how much eth to send) and an optional gasLimit. The reduce
  // operation below deletes any null/undefined elements from this object. If gasLimit or nonce are not specified,
  // ethers will determine the correct values to use.
  const txConfig = Object.entries({ ...gas, value, nonce, gasLimit }).reduce(
    (a, [k, v]) => (v ? ((a[k] = v), a) : a),
    {}
  );

  try {
    return sendRawTxn
      ? await signer.sendTransaction({ to, value, data: args as ethers.utils.BytesLike, ...gas })
      : await contract[method](...(args as Array<unknown>), txConfig);
  } catch (error) {
    // Narrow type. All errors caught here should be Ethers errors.
    if (!typeguards.isEthersError(error)) {
      throw error;
    }

    const getCause = (error: unknown): string => {
      const rpcError = sdkProviders.parseJsonRpcError(error);
      return rpcError?.message.toLowerCase() ?? "unknown error";
    };

    const { errors } = ethers;
    const { code, reason, error: rawError } = error;
    const cause = getCause(rawError);
    let scaleGas = false;
    let message = `Unhandled ${chain} transaction error (${cause})`;
    switch (code) {
      // Transaction fails on simulation. May be due to an actual revert, or due to a gas pricing issue.
      case errors.UNPREDICTABLE_GAS_LIMIT:
        message = `Unable to simulate transaction (${cause}).`;
        if ([cause, reason].some((err) => err.includes("revert"))) {
          logger.warn({ at, message, retries, reason, ...commonFields });
          throw error;
        }
        scaleGas = ["gas", "fee"].some((cause) => cause.includes(reason));
        break;

      case errors.REPLACEMENT_UNDERPRICED:
        message = `Transaction replacement on ${chain} failed at nonce ${nonce} (${cause}).`;
        scaleGas = true;
        break;

      // Undiagnosed issue. Can be a nonce issue, so try to re-sync, and otherwise
      // pull out the underlying error to support manual diagnosis if necessary.
      case errors.SERVER_ERROR:
        message = `Encountered error on ${chain} (${cause}).`;
        nonce = null;
        break;

      // Nonce collisions, likely due to concurrent bot instances running. Re-sync nonce and retry.
      case errors.NONCE_EXPIRED: // fallthrough
        nonce = null;
        message = `Nonce collision detected on ${chain}.`;
        break;

      case errors.TIMEOUT:
        message = `Timed out error on ${chain}.`;
        await delay(0.5); // Unclear whether we'll ever hit this in practice.
        break;

      // Bad errors - likely something wrong in the codebase.
      case errors.INVALID_ARGUMENT: // fallthrough
      case errors.MISSING_ARGUMENT: // fallthrough
      case errors.UNEXPECTED_ARGUMENT: {
        message = `Attempted invalid ${chain} transaction (${cause}).`;
        logger.warn({ at, message, code, reason, ...commonFields });
        throw error;
      }

      default:
        logger.warn({ at, message, code, retries, ...commonFields });
    }

    logger.debug({ at, message, code, reason, ...commonFields });
    if (--retries < 0) {
      throw error;
    }

    if (scaleGas) {
      // Ratchet the gasScaler incrementally on each retry, up to MAX_GAS_RETRY_SCALER;
      const maxGasScaler = Number(process.env[`MAX_GAS_RETRY_SCALER_${chainId}`] ?? MAX_GAS_RETRY_SCALER);
      gasScaler = Math.max(gasScaler, Math.max(priorityFeeScaler, 1.1));
      gasScaler = Math.pow(gasScaler, 2);
      gasScaler = Math.min(gasScaler, maxGasScaler);
    }

    return await runTransaction(logger, contract, method, args, value, gasLimit, nonce, retries, gasScaler);
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
  retryScaler = 1.0
): Pick<FeeData, "maxFeePerGas" | "maxPriorityFeePerGas"> | Pick<FeeData, "gasPrice"> {
  const scaler = toBNWei(retryScaler);
  const flooredPriorityFeePerGas = parseUnits(process.env[`MIN_PRIORITY_FEE_PER_GAS_${chainId}`] || "0", 9);

  // Check if the chain requires legacy transactions
  if (LEGACY_TRANSACTION_CHAINS.includes(chainId)) {
    const gasPrice = sdkUtils.bnMax(gas.maxFeePerGas, flooredPriorityFeePerGas).mul(scaler).div(fixedPointAdjustment);
    return { gasPrice };
  }

  // If the priority fee was increased, the max fee must be scaled up as well.
  const maxPriorityFeePerGas = sdkUtils
    .bnMax(gas.maxPriorityFeePerGas, flooredPriorityFeePerGas)
    .mul(scaler)
    .div(fixedPointAdjustment);
  const maxFeeDelta = maxPriorityFeePerGas.sub(gas.maxPriorityFeePerGas);

  return {
    maxFeePerGas: gas.maxFeePerGas.add(maxFeeDelta),
    maxPriorityFeePerGas,
  };
}
