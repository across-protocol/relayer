// Utils from other packages.
import winston from "winston";
import assert from "assert";
import fetch from "node-fetch";
export { winston, assert, fetch };
export { delay, Logger } from "@uma/financial-templates-lib";

export { BigNumber, Signer, Contract, ContractFactory, Transaction } from "ethers";
export { utils, EventFilter, BaseContract, Event, Wallet } from "ethers";
export { ethers, providers } from "ethers";
export type { Block } from "@ethersproject/abstract-provider";
export { config } from "dotenv";
export { Promise } from "bluebird";

// Utils specifically for this bot.
export * from "./ProviderUtils";
export * from "./SignerUtils";
export * from "./DepositUtils";
export * from "./EventUtils";
export * from "./FillUtils";
export * from "./ObjectUtils";
export * from "./FormattingUtils";
export * from "./TransactionPropBuilder";
export * from "./ContractUtils";
export * from "./ExecutionUtils";
export * from "./NetworkUtils";
export * from "./TransactionUtils";
export * from "./MerkleTreeUtils";
export * from "./AddressUtils";
export * from "./FillMathUtils";
export * from "./GckmsUtils";
export * from "./TimeUtils";

export { ZERO_ADDRESS, MAX_SAFE_ALLOWANCE, MAX_UINT_VAL } from "@uma/common";

// TypeChain exports used in the bot.
export {
  ExpandedERC20__factory as ERC20,
  HubPool__factory as HubPool,
  SpokePool__factory as SpokePool,
  AcrossConfigStore__factory as AcrossConfigStore,
  PolygonTokenBridger__factory as PolygonTokenBridger,
} from "@across-protocol/contracts-v2";

export { getDeployedAddress, getDeployedBlockNumber, getContractInfoFromAddress } from "@across-protocol/contracts-v2";
