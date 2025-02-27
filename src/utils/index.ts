// Utils from other packages.
import { constants as sdkConstants } from "@across-protocol/sdk";
import { constants as ethersConstants } from "ethers";

import winston from "winston";
import assert from "assert";
export { winston, assert };

export const { MAX_SAFE_ALLOWANCE, ZERO_BYTES } = sdkConstants;
export const { AddressZero: ZERO_ADDRESS, MaxUint256: MAX_UINT_VAL } = ethersConstants;

export {
  ethers,
  providers,
  utils,
  BaseContract,
  Contract,
  ContractFactory,
  EventFilter,
  Signer,
  Transaction,
  Wallet,
} from "ethers";
export type { Block, TransactionResponse, TransactionReceipt, Provider } from "@ethersproject/abstract-provider";

export { config } from "dotenv";

export { replaceAddressCase } from "@uma/common";
export { Logger, waitForLogger } from "@uma/logger";

export {
  CHAIN_IDs,
  TESTNET_CHAIN_IDs,
  TOKEN_SYMBOLS_MAP,
  TOKEN_EQUIVALENCE_REMAPPING,
} from "@across-protocol/constants";

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
} from "@across-protocol/contracts";

// Utils specifically for this bot.
export * from "./SDKUtils";
export * from "./chains";
export * from "./fsUtils";
export * from "./ProviderUtils";
export * from "./SignerUtils";
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
export * from "./GckmsUtils";
export * from "./TypeGuards";
export * from "./Help";
export * from "./LogUtils";
export * from "./TypeUtils";
export * from "./RedisUtils";
export * from "./UmaUtils";
export * from "./TokenUtils";
export * from "./CLIUtils";
export * from "./BNUtils";
export * from "./CCTPUtils";
export * from "./RetryUtils";
