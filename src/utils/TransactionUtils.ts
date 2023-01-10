import { AugmentedTransaction } from "../clients";
import { winston, Contract, getContractInfoFromAddress, fetch, ethers } from "../utils";
import { toBNWei, BigNumber, toBN, toGWei, TransactionResponse } from "../utils";

// Note that this function will throw if the call to the contract on method for given args reverts. Implementers
// of this method should be considerate of this and catch the response to deal with the error accordingly.
export async function runTransaction(
  logger: winston.Logger,
  contract: Contract,
  method: string,
  args: any,
  value: BigNumber = toBN(0),
  gasLimit: BigNumber | null = null,
  nonce: number | null = null
): Promise<TransactionResponse> {
  try {
    const gas = await getGasPrice(contract.provider);
    logger.debug({
      at: "TxUtil",
      message: "Send tx",
      target: getTarget(contract.address),
      method,
      args,
      value,
      nonce,
      gas,
    });
    // TX config has gas (from gasPrice function), value (how much eth to send) and an optional gasLimit. The reduce
    // operation below deletes any null/undefined elements from this object. If the gasLimit is not specified, for example,
    // then leave this up to ethers to compute. Similarly, if nonce is not specified, 
    // then ethers will query the RPC provider for the latest nonce
    const txConfig = Object.entries({ ...gas, value, nonce, gasLimit }).reduce(
      (a, [k, v]) => (v ? ((a[k] = v), a) : a),
      {}
    );
    return await contract[method](...args, txConfig);
  } catch (error) {
    logger.error({
      at: "TxUtil",
      message: "Error executing tx",
      error: JSON.stringify(error),
      notificationPath: "across-error",
    });
    throw error;
  }
}

// TODO: add in gasPrice when the SDK has this for the given chainId. TODO: improve how we fetch prices.
// For now this method will extract the provider's Fee data from the associated network and scale it by a priority
// scaler. This works on both mainnet and L2's by the utility switching the response structure accordingly.
export async function getGasPrice(provider: ethers.providers.Provider, priorityScaler = 1.2, maxFeePerGasScaler = 3) {
  const [feeData, chainInfo] = await Promise.all([provider.getFeeData(), provider.getNetwork()]);
  if (feeData.maxFeePerGas && feeData.maxPriorityFeePerGas) {
    // Polygon, for some or other reason, does not correctly return an appropriate maxPriorityFeePerGas. Set the
    // maxPriorityFeePerGas to the maxFeePerGas * 5 for now as a temp workaround.
    if (chainInfo.chainId === 137)
      feeData.maxPriorityFeePerGas = toGWei((await getPolygonPriorityFee()).fastest.toString());
    if (feeData.maxPriorityFeePerGas.gt(feeData.maxFeePerGas))
      feeData.maxFeePerGas = scaleByNumber(feeData.maxPriorityFeePerGas, 1.5);
    return {
      maxFeePerGas: scaleByNumber(feeData.maxFeePerGas, priorityScaler * maxFeePerGasScaler), // scale up the maxFeePerGas. Any extra paid on this is refunded.
      maxPriorityFeePerGas: scaleByNumber(feeData.maxPriorityFeePerGas, priorityScaler),
    };
  } else return { gasPrice: scaleByNumber(feeData.gasPrice, priorityScaler) };
}

export async function willSucceed(
  transaction: AugmentedTransaction
): Promise<{ transaction: AugmentedTransaction; succeed: boolean; reason: string }> {
  try {
    const args = transaction.value ? [...transaction.args, { value: transaction.value }] : transaction.args;
    await transaction.contract.callStatic[transaction.method](...args);
    return { transaction, succeed: true, reason: null };
  } catch (error) {
    return { transaction, succeed: false, reason: error.reason };
  }
}

export function getTarget(targetAddress: string) {
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
  const res = await fetch("https://gasstation-mainnet.matic.network");
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
