import { HardhatEthersHelpers } from "@nomiclabs/hardhat-ethers/types";
import type { ethers } from "ethers";
import winston from "winston";
import * as utils from "@across-protocol/contracts-v2/dist/test-utils";
import { sinon } from "../utils";

export type EthersTestLibrary = typeof ethers & HardhatEthersHelpers;
export type SpyLoggerResult = {
  spy: sinon.SinonSpy<unknown[], unknown>;
  spyLogger: winston.Logger;
};

export type SpokePoolDeploymentResult = {
  weth: utils.Contract;
  erc20: utils.Contract;
  spokePool: utils.Contract;
  unwhitelistedErc20: utils.Contract;
  destErc20: utils.Contract;
  deploymentBlock: number;
};

export type ContractsV2SlowFillRelayData = {
  depositor: string;
  recipient: string;
  destinationToken: string;
  amount: utils.BigNumber;
  realizedLpFeePct: utils.BigNumber;
  relayerFeePct: utils.BigNumber;
  depositId: string;
  originChainId: string;
  destinationChainId: string;
  message: string;
};

export type ContractsV2SlowFill = {
  relayData: ContractsV2SlowFillRelayData;
  payoutAdjustmentPct: utils.BigNumber;
};
