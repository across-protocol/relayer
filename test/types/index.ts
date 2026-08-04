import { HardhatEthersHelpers } from "@nomiclabs/hardhat-ethers/types";
import type { ethers } from "ethers";
import winston from "winston";
import * as sdkTestUtils from "@across-protocol/sdk/test-utils";
import { sinon } from "../utils";

export type EthersTestLibrary = typeof ethers & HardhatEthersHelpers;
export type SpyLoggerResult = {
  spy: sinon.SinonSpy<unknown[], unknown>;
  spyLogger: winston.Logger;
};

export type SpokePoolDeploymentResult = {
  weth: sdkTestUtils.Contract;
  erc20: sdkTestUtils.Contract;
  spokePool: sdkTestUtils.Contract;
  unwhitelistedErc20: sdkTestUtils.Contract;
  destErc20: sdkTestUtils.Contract;
  deploymentBlock: number;
};

export type ContractsV2SlowFillRelayData = {
  depositor: string;
  recipient: string;
  destinationToken: string;
  amount: sdkTestUtils.BigNumber;
  realizedLpFeePct: sdkTestUtils.BigNumber;
  relayerFeePct: sdkTestUtils.BigNumber;
  depositId: string;
  originChainId: string;
  destinationChainId: string;
  message: string;
};

export type ContractsV2SlowFill = {
  relayData: ContractsV2SlowFillRelayData;
  payoutAdjustmentPct: sdkTestUtils.BigNumber;
};
