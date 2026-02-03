import { HardhatUserConfig } from "hardhat/config";
import "@nomiclabs/hardhat-ethers";
import "@nomicfoundation/hardhat-chai-matchers";
import "@typechain/hardhat";
import "hardhat-deploy";
import "@openzeppelin/hardhat-upgrades";

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
  },
  paths: {
    sources: "contracts-test",
  },
  mocha: { timeout: 100000 },
};

export default config;
