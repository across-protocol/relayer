import assert from "assert";
import { Contract, Signer } from "ethers";
import readline from "readline";
import * as contracts from "@across-protocol/contracts";
import { utils as sdkUtils } from "@across-protocol/sdk";
import { getDeployedContract, getProvider, CHAIN_IDs } from "../src/utils";

// https://nodejs.org/api/process.html#exit-codes
export const NODE_SUCCESS = 0;
export const NODE_INPUT_ERR = 9;
export const NODE_APP_ERR = 127; // user-defined

async function askQuestion(query: string) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  return new Promise((resolve) =>
    rl.question(query, (ans) => {
      rl.close();
      resolve(ans);
    })
  );
}

export async function askYesNoQuestion(query: string): Promise<boolean> {
  const ans = (await askQuestion(`${query} (y/n) `)) as string;
  if (ans.toLowerCase() === "y") {
    return true;
  }
  if (ans.toLowerCase() === "n") {
    return false;
  }
  return askYesNoQuestion(query);
}

/**
 * @description Verify that an array of chain IDs have known Across deployments.
 * @dev This function does not detect if the test and production chain IDs have been mixed.
 * @param chainIds Array of chain IDs to validate.
 * @returns True if all chainIds are known.
 */
export function validateChainIds(chainIds: number[]): boolean {
  return (
    chainIds.every((chainId) => sdkUtils.chainIsProd(chainId)) ||
    chainIds.every((chainId) => sdkUtils.chainIsTestnet(chainId))
  );
}

/**
 * @description For a SpokePool chain ID, resolve its corresponding HubPool chain ID.
 * @param spokeChainId Chain ID of the SpokePool.
 * @returns Chain ID for the corresponding HubPool.
 */
export function resolveHubChainId(spokeChainId: number): number {
  if (sdkUtils.chainIsProd(spokeChainId)) {
    return CHAIN_IDs.MAINNET;
  }

  assert(sdkUtils.chainIsTestnet(spokeChainId), `Unsupported testnet SpokePool chain ID: ${spokeChainId}`);
  return CHAIN_IDs.SEPOLIA;
}

/**
 * @description Instantiate an ethers Contract instance.
 * @param chainId Chain ID for the contract deployment.
 * @param contractName Name of the deployed contract.
 * @returns ethers Contract instance.
 */
export async function getContract(chainId: number, contractName: string): Promise<Contract> {
  const contract = getDeployedContract(contractName, chainId);
  const provider = await getProvider(chainId);
  return contract.connect(provider);
}

/**
 * @description Instantiate an Across SpokePool contract instance.
 * @param chainId Chain ID for the SpokePool deployment.
 * @returns SpokePool contract instance.
 */
export async function getSpokePoolContract(chainId: number): Promise<Contract> {
  const hubChainId = resolveHubChainId(chainId);
  const hubPool = await getContract(hubChainId, "HubPool");
  const spokePoolAddr = (await hubPool.crossChainContracts(chainId))[1];

  const contract = new Contract(spokePoolAddr, contracts.SpokePool__factory.abi);
  return contract;
}

/**
 * @description Instantiate an Across OVM SpokePool contract instance.
 * @param chainId Chain ID for the SpokePool deployment.
 * @returns SpokePool contract instance.
 */
export async function getOvmSpokePoolContract(chainId: number, signer?: Signer): Promise<Contract> {
  const hubChainId = resolveHubChainId(chainId);
  const hubPool = await getContract(hubChainId, "HubPool");
  const spokePoolAddr = (await hubPool.crossChainContracts(chainId))[1];

  const contract = new Contract(spokePoolAddr, contracts.Ovm_SpokePool__factory.abi, signer);
  return contract;
}
