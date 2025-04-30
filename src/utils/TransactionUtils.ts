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
  TransactionResponse,
  ethers,
  getContractInfoFromAddress,
  Signer,
  toBNWei,
  winston,
  stringifyThrownValue,
} from "../utils";
dotenv.config();

export type TransactionSimulationResult = {
  transaction: AugmentedTransaction;
  succeed: boolean;
  reason?: string;
  data?: any;
};

const { isError, isEthersError } = typeguards;

export type Multicall2Call = {
  callData: ethers.utils.BytesLike;
  target: string;
};

const nonceReset: { [chainId: number]: boolean } = {};

const txnRetryErrors = new Set(["INSUFFICIENT_FUNDS", "NONCE_EXPIRED", "REPLACEMENT_UNDERPRICED"]);
const expectedRpcErrorMessages = new Set(["nonce has already been used", "intrinsic gas too low"]);
const txnRetryable = (error?: unknown): boolean => {
  if (isEthersError(error)) {
    return txnRetryErrors.has(error.code);
  }

  return expectedRpcErrorMessages.has((error as Error)?.message);
};

export function getNetworkError(err: unknown): string {
  return isEthersError(err) ? err.reason : isError(err) ? err.message : "unknown error";
}

export async function getMultisender(chainId: number, baseSigner: Signer): Promise<Contract | undefined> {
  return sdkUtils.getMulticall3(chainId, baseSigner);
}

// Note that this function will throw if the call to the contract on method for given args reverts. Implementers
// of this method should be considerate of this and catch the response to deal with the error accordingly.
export async function runTransaction(
  logger: winston.Logger,
  contract: Contract,
  method: string,
  args: unknown,
  value = bnZero,
  gasLimit: BigNumber | null = null,
  nonce: number | null = null,
  retriesRemaining = 1
): Promise<TransactionResponse> {
  const { provider } = contract;
  const { chainId } = await provider.getNetwork();

  if (!nonceReset[chainId]) {
    nonce = await provider.getTransactionCount(await contract.signer.getAddress());
    nonceReset[chainId] = true;
  }

  try {
    const priorityFeeScaler =
      Number(process.env[`PRIORITY_FEE_SCALER_${chainId}`] || process.env.PRIORITY_FEE_SCALER) ||
      DEFAULT_GAS_FEE_SCALERS[chainId]?.maxPriorityFeePerGasScaler;
    const maxFeePerGasScaler =
      Number(process.env[`MAX_FEE_PER_GAS_SCALER_${chainId}`] || process.env.MAX_FEE_PER_GAS_SCALER) ||
      DEFAULT_GAS_FEE_SCALERS[chainId]?.maxFeePerGasScaler;

    const gas = await getGasPrice(
      provider,
      priorityFeeScaler,
      maxFeePerGasScaler,
      await contract.populateTransaction[method](...(args as Array<unknown>), { value })
    );

    logger.debug({
      at: "TxUtil",
      message: "Send tx",
      target: getTarget(contract.address),
      method,
      args,
      value,
      nonce,
      gas,
      gasLimit,
    });
    // TX config has gas (from gasPrice function), value (how much eth to send) and an optional gasLimit. The reduce
    // operation below deletes any null/undefined elements from this object. If gasLimit or nonce are not specified,
    // ethers will determine the correct values to use.
    const txConfig = Object.entries({ ...gas, value, nonce, gasLimit }).reduce(
      (a, [k, v]) => (v ? ((a[k] = v), a) : a),
      {}
    );
    return await contract[method](...(args as Array<unknown>), txConfig);
  } catch (error) {
    if (retriesRemaining > 0 && txnRetryable(error)) {
      // If error is due to a nonce collision or gas underpricement then re-submit to fetch latest params.
      retriesRemaining -= 1;
      logger.debug({
        at: "TxUtil#runTransaction",
        message: "Retrying txn due to expected error",
        error: stringifyThrownValue(error),
        retriesRemaining,
      });

      return await runTransaction(logger, contract, method, args, value, gasLimit, null, retriesRemaining);
    } else {
      // Empirically we have observed that Ethers can produce nested errors, so we try to recurse down them
      // and log them as clearly as possible. For example:
      // - Top-level (Contract method call): "reason":"cannot estimate gas; transaction may fail or may require manual gas limit" (UNPREDICTABLE_GAS_LIMIT)
      // - Mid-level (eth_estimateGas): "reason":"execution reverted: delegatecall failed" (UNPREDICTABLE_GAS_LIMIT)
      // - Bottom-level (JSON-RPC/HTTP): "reason":"processing response error" (SERVER_ERROR)
      const commonFields = {
        at: "TxUtil#runTransaction",
        message: "Error executing tx",
        retriesRemaining,
        target: getTarget(contract.address),
        method,
        args,
        value,
        nonce,
        notificationPath: "across-error",
      };
      if (isEthersError(error)) {
        const ethersErrors: { reason: string; err: EthersError }[] = [];
        let topError = error;
        while (isEthersError(topError)) {
          ethersErrors.push({ reason: topError.reason, err: topError.error as EthersError });
          topError = topError.error as EthersError;
        }
        logger[ethersErrors.some((e) => txnRetryable(e.err)) ? "warn" : "error"]({
          ...commonFields,
          errorReasons: ethersErrors.map((e, i) => `\t ${i}: ${e.reason}`).join("\n"),
        });
      } else {
        logger[txnRetryable(error) ? "warn" : "error"]({
          ...commonFields,
          error: stringifyThrownValue(error),
        });
      }
      throw error;
    }
  }
}

export async function getGasPrice(
  provider: ethers.providers.Provider,
  priorityScaler = 1.2,
  maxFeePerGasScaler = 3,
  transactionObject?: ethers.PopulatedTransaction
): Promise<Partial<FeeData>> {
  // Floor scalers at 1.0 as we'll rarely want to submit too low of a gas price. We mostly
  // just want to submit with as close to prevailing fees as possible.
  maxFeePerGasScaler = Math.max(1, maxFeePerGasScaler);
  priorityScaler = Math.max(1, priorityScaler);
  const { chainId } = await provider.getNetwork();
  // Pass in unsignedTx here for better Linea gas price estimations via the Linea Viem provider.
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
  // This is useful for surfacing custom error revert reasons like RelayFilled in the V3 SpokePool but
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
