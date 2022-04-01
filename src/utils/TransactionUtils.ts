import { winston, Contract, toBN } from "../utils";

// Note that this function will throw if the call to the contract on method for given args reverts. Implementers
// of this method should be considerate of this and catch the response to deal with the error accordingly.
export async function runTransaction(logger: winston.Logger, contract: Contract, method: string, args: any) {
  try {
    const gas = await getGasPrice(contract.provider);
    logger.debug({ at: "TransactionUtil", message: "sending tx", target: contract.address, method, args, gas });
    return await contract[method](...args, gas);
  } catch (error) {
    throw new Error(error.reason); // Extract the reason from the transaction error and throw it.
  }
}

//TODO: add in gasPrice when the SDK has this for the given chainId.
// For now this method will extract the provider's Fee data from the associated network and scale it by a priority
// scaler. This works on both mainnet and L2's by the utility switching the response structure accordingly.
export async function getGasPrice(provider, priorityScaler = toBN(1.2)) {
  const feeData = await provider.getFeeData();
  if (feeData.maxFeePerGas && feeData.maxPriorityFeePerGas)
    return {
      maxFeePerGas: feeData.maxFeePerGas.mul(priorityScaler),
      maxPriorityFeePerGas: feeData.maxPriorityFeePerGas.mul(priorityScaler),
    };
  else return { gasPrice: feeData.gasPrice.mul(priorityScaler) };
}

export async function willSucceed(
  contract: Contract,
  method: string,
  args: any
): Promise<{ succeed: boolean; reason: string }> {
  try {
    await contract.callStatic[method](...args);
    return { succeed: true, reason: null };
  } catch (error) {
    return { succeed: false, reason: error.reason };
  }
}
