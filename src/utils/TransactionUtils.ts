import { AugmentedTransaction } from "../clients";
import { winston, Contract, toBN, getContractInfoFromAddress } from "../utils";

// Note that this function will throw if the call to the contract on method for given args reverts. Implementers
// of this method should be considerate of this and catch the response to deal with the error accordingly.
export async function runTransaction(logger: winston.Logger, contract: Contract, method: string, args: any) {
  try {
    const gas = await getGasPrice(contract.provider);
    logger.debug({ at: "TxUtil", message: "sending tx", target: getTarget(contract.address), method, args, gas });
    return await contract[method](...args, gas);
  } catch (error) {
    logger.error({ at: "TxUtil", message: "Error executing tx", error });
    throw new Error(error.reason); // Extract the reason from the transaction error and throw it.
  }
}

//TODO: add in gasPrice when the SDK has this for the given chainId. TODO: improve how we fetch prices.
// For now this method will extract the provider's Fee data from the associated network and scale it by a priority
// scaler. This works on both mainnet and L2's by the utility switching the response structure accordingly.
export async function getGasPrice(provider, priorityScaler = toBN(1.2)) {
  const feeData = await provider.getFeeData();
  if (feeData.maxFeePerGas && feeData.maxPriorityFeePerGas) {
    // Polygon, for some or other reason, does not correctly return an appropriate maxPriorityFeePerGas and always
    // returns 1500000000 for this number. Set to the maxFeePerGas for now as a temp workaround.
    if (feeData.maxPriorityFeePerGas.eq(toBN(1500000000))) feeData.maxPriorityFeePerGas = feeData.maxFeePerGas;
    return {
      maxFeePerGas: feeData.maxFeePerGas.mul(priorityScaler),
      maxPriorityFeePerGas: feeData.maxPriorityFeePerGas.mul(priorityScaler),
    };
  } else return { gasPrice: feeData.gasPrice.mul(priorityScaler) };
}

export async function willSucceed(
  transaction: AugmentedTransaction
): Promise<{ transaction: AugmentedTransaction; succeed: boolean; reason: string }> {
  try {
    await transaction.contract.callStatic[transaction.method](...transaction.args);
    return { transaction, succeed: true, reason: null };
  } catch (error) {
    return { transaction, succeed: false, reason: error.reason };
  }
}

export function getTarget(targetAddress: string) {
  return { targetAddress, ...getContractInfoFromAddress(targetAddress) };
}
