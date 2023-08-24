import { HardhatEthersHelpers } from "@nomiclabs/hardhat-ethers/types";
import type { ethers } from "ethers";

export type EthersTestLibrary = typeof ethers & HardhatEthersHelpers;
