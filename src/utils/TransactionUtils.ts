import { AugmentedTransaction } from "../clients";
import { winston, Contract, getContractInfoFromAddress, fetch, ethers, toBNWei, BigNumber, toBN } from "../utils";

// Note that this function will throw if the call to the contract on method for given args reverts. Implementers
// of this method should be considerate of this and catch the response to deal with the error accordingly.
export async function runTransaction(
  logger: winston.Logger,
  contract: Contract,
  method: string,
  args: any,
  value: BigNumber = toBN(0)
) {
  try {
    const gas = await getGasPrice(contract.provider);
    logger.debug({ at: "TxUtil", message: "sending tx", target: getTarget(contract.address), method, args, gas });
    return await contract[method](...args, { ...gas, value });
  } catch (error) {
    logger.error({ at: "TxUtil", message: "Error executing tx", error, notificationPath: "across-error" });
    console.log(error);
    throw new Error(error.reason); // Extract the reason from the transaction error and throw it.
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
      feeData.maxPriorityFeePerGas = ethers.utils.parseUnits((await getPolygonPriorityFee()).fastest.toString(), 9);
    if (feeData.maxPriorityFeePerGas > feeData.maxFeePerGas)
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
    await transaction.contract.callStatic[transaction.method](...transaction.args);
    return { transaction, succeed: true, reason: null };
  } catch (error) {
    console.error(error);
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
  return await res.json();
}

function scaleByNumber(amount: ethers.BigNumber, scaling: number) {
  return amount.mul(toBNWei(scaling)).div(toBNWei("1"));
}
