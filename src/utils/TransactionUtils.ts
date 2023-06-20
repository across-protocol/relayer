import { typeguards } from "@across-protocol/sdk-v2";
import { AugmentedTransaction } from "../clients";
import { winston, Contract, getContractInfoFromAddress, fetch, ethers, Wallet } from "../utils";
import { DEFAULT_GAS_FEE_SCALERS, multicall3Addresses } from "../common";
import { toBNWei, BigNumber, toBN, toGWei, TransactionResponse } from "../utils";
import { getAbi } from "@uma/contracts-node";
import dotenv from "dotenv";
import { FeeData } from "@ethersproject/abstract-provider";
import { EthersError } from "../interfaces";
dotenv.config();

export type TransactionSimulationResult = {
  transaction: AugmentedTransaction;
  succeed: boolean;
  reason?: string;
};

const txnRetryErrors = new Set(["INSUFFICIENT_FUNDS", "NONCE_EXPIRED", "REPLACEMENT_UNDERPRICED"]);
const txnRetryable = (error?: unknown): boolean => {
  if (typeguards.isEthersError(error)) {
    return txnRetryErrors.has(error.code);
  }

  return (error as Error)?.message?.includes("intrinsic gas too low");
};

export function getMultisender(chainId: number, baseSigner: Wallet): Contract | undefined {
  if (!multicall3Addresses[chainId] || !baseSigner) {
    return undefined;
  }
  return new Contract(multicall3Addresses[chainId], getAbi("Multicall3"), baseSigner);
}

// Note that this function will throw if the call to the contract on method for given args reverts. Implementers
// of this method should be considerate of this and catch the response to deal with the error accordingly.
export async function runTransaction(
  logger: winston.Logger,
  contract: Contract,
  method: string,
  args: unknown,
  value: BigNumber = toBN(0),
  gasLimit: BigNumber | null = null,
  nonce: number | null = null,
  retriesRemaining = 2
): Promise<TransactionResponse> {
  const chainId = (await contract.provider.getNetwork()).chainId;

  try {
    const priorityFeeScaler =
      Number(process.env[`PRIORITY_FEE_SCALER_${chainId}`] || process.env.PRIORITY_FEE_SCALER) ||
      DEFAULT_GAS_FEE_SCALERS[chainId]?.maxPriorityFeePerGasScaler;
    const maxFeePerGasScaler =
      Number(process.env[`MAX_FEE_PER_GAS_SCALER_${chainId}`] || process.env.MAX_FEE_PER_GAS_SCALER) ||
      DEFAULT_GAS_FEE_SCALERS[chainId]?.maxFeePerGasScaler;

    const gas = await getGasPrice(contract.provider, priorityFeeScaler, maxFeePerGasScaler);

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
        error: JSON.stringify(error),
        retriesRemaining,
      });

      return await runTransaction(logger, contract, method, args, value, gasLimit, null, retriesRemaining);
    } else {
      // Empirically we have observed that Ethers can produce nested errors, so we try to recurse down them
      // and log them as clearly as possible. For example:
      // - Top-level (Contract method call): "reason":"cannot estimate gas; transaction may fail or may require manual gas limit" (UNPREDICTABLE_GAS_LIMIT)
      // - Mid-level (eth_estimateGas): "reason":"execution reverted: delegatecall failed" (UNPREDICTABLE_GAS_LIMIT)
      // - Bottom-level (JSON-RPC/HTTP): "reason":"processing response error" (SERVER_ERROR)
      if (typeguards.isEthersError(error)) {
        const ethersErrors: { reason: string; err: EthersError }[] = [];
        let topError: EthersError = error as EthersError;
        while (topError !== undefined) {
          ethersErrors.push({ reason: topError.reason, err: topError.error });
          topError = topError.error;
        }
        logger[ethersErrors.some((e) => txnRetryable(e.err)) ? "warn" : "error"]({
          at: "TxUtil#runTransaction",
          message: "Error executing tx",
          retriesRemaining,
          errorReasons: ethersErrors.map((e, i) => `\t ${i}: ${e.reason}`).join("\n"),
          target: getTarget(contract.address),
          method,
          args,
          value,
          nonce,
          notificationPath: "across-error",
        });
        throw error;
      } else {
        logger[txnRetryable(error) ? "warn" : "error"]({
          at: "TxUtil#runTransaction",
          message: "Error executing tx",
          retriesRemaining,
          error: JSON.stringify(error),
          target: getTarget(contract.address),
          method,
          args,
          value,
          nonce,
          notificationPath: "across-error",
        });
        throw error;
      }
    }
  }
}

// TODO: add in gasPrice when the SDK has this for the given chainId. TODO: improve how we fetch prices.
// For now this method will extract the provider's Fee data from the associated network and scale it by a priority
// scaler. This works on both mainnet and L2's by the utility switching the response structure accordingly.
export async function getGasPrice(
  provider: ethers.providers.Provider,
  priorityScaler = 1.2,
  maxFeePerGasScaler = 3
): Promise<Partial<FeeData>> {
  const [feeData, chainInfo] = await Promise.all([provider.getFeeData(), provider.getNetwork()]);
  if (feeData.maxFeePerGas && feeData.maxPriorityFeePerGas) {
    // Polygon, for some or other reason, does not correctly return an appropriate maxPriorityFeePerGas. Set the
    // maxPriorityFeePerGas to the maxFeePerGas * 5 for now as a temp workaround.
    if (chainInfo.chainId === 137) {
      feeData.maxPriorityFeePerGas = toGWei((await getPolygonPriorityFee()).fastest.toString());
    }
    if (feeData.maxPriorityFeePerGas.gt(feeData.maxFeePerGas)) {
      feeData.maxFeePerGas = scaleByNumber(feeData.maxPriorityFeePerGas, 1.5);
    }
    return {
      maxFeePerGas: scaleByNumber(feeData.maxFeePerGas, priorityScaler * maxFeePerGasScaler), // scale up the maxFeePerGas. Any extra paid on this is refunded.
      maxPriorityFeePerGas: scaleByNumber(feeData.maxPriorityFeePerGas, priorityScaler),
    };
  } else {
    return { gasPrice: scaleByNumber(feeData.gasPrice, priorityScaler) };
  }
}

export async function willSucceed(transaction: AugmentedTransaction): Promise<TransactionSimulationResult> {
  if (transaction.canFailInSimulation) {
    return { transaction, succeed: true };
  }
  try {
    const { contract, method } = transaction;
    const args = transaction.value ? [...transaction.args, { value: transaction.value }] : transaction.args;
    const gasLimit = await contract.estimateGas[method](...args);
    return { transaction: { ...transaction, gasLimit }, succeed: true };
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

async function getPolygonPriorityFee(): Promise<{
  safeLow: number;
  standard: number;
  fast: number;
  fastest: number;
  blockTime: number;
  blockNumber: number;
}> {
  const res = await fetch("https://gasstation.polygon.technology");
  return (await res.json()) as {
    safeLow: number;
    standard: number;
    fast: number;
    fastest: number;
    blockTime: number;
    blockNumber: number;
  };
}

function scaleByNumber(amount: ethers.BigNumber, scaling: number) {
  return amount.mul(toBNWei(scaling)).div(toBNWei("1"));
}
