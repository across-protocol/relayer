// Utils from other packages.
import winston from "winston";
import assert from "assert";
export { winston, assert };
export { Logger } from "@uma/financial-templates-lib";

export { BigNumber, Signer, Contract, ContractFactory, Transaction, BigNumberish } from "ethers";
export { utils, EventFilter, BaseContract, Event, Wallet } from "ethers";
export { ethers, providers } from "ethers";
export type { Block, TransactionResponse, TransactionReceipt, Provider } from "@ethersproject/abstract-provider";
export { config } from "dotenv";

// Utils specifically for this bot.
export * from "./chains";
export * from "./ProviderUtils";
export * from "./SignerUtils";
export * from "./DepositUtils";
export * from "./BlockUtils";
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
export * from "./TypeGuards";
export * from "./Help";
export * from "./LogUtils";
export * from "./TypeUtils";
export * from "./BigNumberUtils";
export * from "./RedisUtils";
export * from "./UmaUtils";
export * from "./TokenUtils";

export { ZERO_ADDRESS, MAX_SAFE_ALLOWANCE, MAX_UINT_VAL, replaceAddressCase } from "@uma/common";

// TypeChain exports used in the bot.
export {
  ExpandedERC20__factory as ERC20,
  HubPool__factory as HubPool,
  SpokePool__factory as SpokePool,
  AcrossConfigStore__factory as AcrossConfigStore,
  PolygonTokenBridger__factory as PolygonTokenBridger,
  WETH9__factory as WETH9,
} from "@across-protocol/contracts-v2";

export { getDeployedAddress, getDeployedBlockNumber, getContractInfoFromAddress } from "@across-protocol/contracts-v2";
