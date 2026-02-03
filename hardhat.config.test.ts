import { HardhatUserConfig } from "hardhat/config";
import "@nomiclabs/hardhat-ethers";
import "@nomicfoundation/hardhat-chai-matchers";
import "@typechain/hardhat";
import "hardhat-deploy";

const config: HardhatUserConfig = {
  solidity: {
    compilers: [
      {
        version: "0.8.26",
        settings: { optimizer: { enabled: true, runs: 1 }, viaIR: true, evmVersion: "cancun" },
      },
    ],
  },
  networks: {
    hardhat: { accounts: { accountsBalance: "1000000000000000000000000" } },
    polygon: {
      chainId: 137,
      url: process.env.POLYGON_RPC_URL ?? "https://polygon-rpc.com",
      accounts: process.env.PRIVATE_KEY ? [process.env.PRIVATE_KEY] : [],
    },
  },
  paths: {
    sources: "contracts-test",
  },
  mocha: { timeout: 100000 },
};

export default config;
