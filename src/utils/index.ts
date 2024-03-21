// Utils from other packages.
import { constants as sdkConstants } from "@across-protocol/sdk-v2";
import { constants as ethersConstants } from "ethers";

import winston from "winston";
import assert from "assert";
export { winston, assert };

export const { MAX_SAFE_ALLOWANCE } = sdkConstants;
export const { AddressZero: ZERO_ADDRESS, MaxUint256: MAX_UINT_VAL } = ethersConstants;

export {
  ethers,
  providers,
  utils,
  BaseContract,
  BigNumber,
  BigNumberish,
  Contract,
  ContractFactory,
  Event,
  EventFilter,
  Signer,
  Transaction,
  Wallet,
} from "ethers";
export type { Block, TransactionResponse, TransactionReceipt, Provider } from "@ethersproject/abstract-provider";

export { config } from "dotenv";

export { replaceAddressCase } from "@uma/common";
export { Logger } from "@uma/financial-templates-lib";

export { CHAIN_IDs, TOKEN_SYMBOLS_MAP } from "@across-protocol/constants-v2";

// TypeChain exports used in the bot.
export {
  getContractInfoFromAddress,
  getDeployedAddress,
  getDeployedBlockNumber,
  ExpandedERC20__factory as ERC20,
  HubPool__factory as HubPool,
  SpokePool__factory as SpokePool,
  AcrossConfigStore__factory as AcrossConfigStore,
  PolygonTokenBridger__factory as PolygonTokenBridger,
  WETH9__factory as WETH9,
} from "@across-protocol/contracts-v2";

// Utils specifically for this bot.
export * from "./SDKUtils";
export * from "./chains";
export * from "./fsUtils";
export * from "./ProviderUtils";
export * from "./SignerUtils";
export * from "./DepositUtils";
export * from "./BlockUtils";
export * from "./EventUtils";
export * from "./FillUtils";
export * from "./ObjectUtils";
export * from "./ContractUtils";
export * from "./ExecutionUtils";
export * from "./NetworkUtils";
export * from "./TransactionUtils";
export * from "./MerkleTreeUtils";
export * from "./AddressUtils";
export * from "./FillMathUtils";
export * from "./GckmsUtils";
export * from "./TimeUtils";
export * from "./TypeGuards";
export * from "./Help";
export * from "./LogUtils";
export * from "./TypeUtils";
export * from "./RedisUtils";
export * from "./UmaUtils";
export * from "./TokenUtils";
export * from "./CLIUtils";
