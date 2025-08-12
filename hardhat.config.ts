import assert from "assert";
import * as dotenv from "dotenv";
import { HardhatUserConfig } from "hardhat/config";
import { CHAIN_IDs, getNetworkName, getNodeUrlList, isDefined, PUBLIC_NETWORKS } from "./src/utils";

// Custom tasks to add to HRE.
// FIXME: Temporarily commenting out tasks to minimize amount of files imported and executed at compile time
// to construct the Hardhat Runtime Environment. Generally we'd prefer to keep the HRE construction
// lightweight and put runnable scripts in the `scripts` directory rather than add as an HRE task.
// TODO: Figure out which imported module in `./tasks` is causing HRE construction to fail.
// require("./tasks");

import "@nomiclabs/hardhat-etherscan";
import "@nomiclabs/hardhat-waffle";
import "@typechain/hardhat";
import "hardhat-gas-reporter";
import "solidity-coverage";
import "hardhat-deploy";
import "@openzeppelin/hardhat-upgrades";

dotenv.config();

const solcVersion = "0.8.23";

const LARGE_CONTRACT_COMPILER_SETTINGS = {
  version: solcVersion,
  settings: {
    optimizer: { enabled: true, runs: 1000000 },
    viaIR: true,
  },
};

const getNodeUrl = (chainId: number): string => {
  const chain = getNetworkName(chainId);
  let url: string;
  try {
    url = Object.values(getNodeUrlList(chainId)).at(0);
  } catch {
    // eslint-disable-next-line no-console
    console.log(`No configured RPC provider for ${chain}, reverting to public RPC.`);
    url = PUBLIC_NETWORKS[chainId].publicRPC;
  }

  assert(isDefined(url), `No known RPC provider for ${chain}`);
  return url;
};

const getMnemonic = () => {
  // Publicly-disclosed mnemonic. This is required for hre deployments in test.
  const PUBLIC_MNEMONIC = "candy maple cake sugar pudding cream honey rich smooth crumble sweet treat";
  const { MNEMONIC = PUBLIC_MNEMONIC } = process.env;
  return MNEMONIC;
};
const mnemonic = getMnemonic();

const config: HardhatUserConfig = {
  solidity: {
    compilers: [{ version: solcVersion, settings: { optimizer: { enabled: true, runs: 1 }, viaIR: true } }],
    overrides: {
      "contracts/AtomicWethDepositor.sol": LARGE_CONTRACT_COMPILER_SETTINGS,
    },
  },
  networks: {
    hardhat: { accounts: { accountsBalance: "1000000000000000000000000" } },
    mainnet: {
      chainId: CHAIN_IDs.MAINNET,
      url: getNodeUrl(CHAIN_IDs.MAINNET),
      accounts: { mnemonic },
      saveDeployments: true,
    },
    sepolia: {
      chainId: CHAIN_IDs.SEPOLIA,
      url: getNodeUrl(CHAIN_IDs.SEPOLIA),
      accounts: { mnemonic },
      saveDeployments: true,
    },
    optimism: {
      chainId: CHAIN_IDs.OPTIMISM,
      url: getNodeUrl(CHAIN_IDs.OPTIMISM),
      accounts: { mnemonic },
      saveDeployments: true,
      companionNetworks: { l1: "mainnet" },
    },
    arbitrum: {
      chainId: CHAIN_IDs.ARBITRUM,
      url: getNodeUrl(CHAIN_IDs.ARBITRUM),
      saveDeployments: true,
      accounts: { mnemonic },
      companionNetworks: { l1: "mainnet" },
    },
    zksync: {
      chainId: CHAIN_IDs.ZK_SYNC,
      url: getNodeUrl(CHAIN_IDs.ZK_SYNC),
      saveDeployments: true,
      accounts: { mnemonic },
      companionNetworks: { l1: "mainnet" },
      zksync: true,
    },
    base: {
      chainId: CHAIN_IDs.BASE,
      url: getNodeUrl(CHAIN_IDs.BASE),
      saveDeployments: true,
      accounts: { mnemonic },
      companionNetworks: { l1: "mainnet" },
    },
  },
  gasReporter: { enabled: process.env.REPORT_GAS !== undefined, currency: "USD" },
  etherscan: { apiKey: process.env.ETHERSCAN_API_KEY },
  namedAccounts: { deployer: 0 },
  mocha: {
    timeout: 100000,
  },
};

export default config;
