import * as utils from "@across-protocol/contracts/dist/test-utils";
import { SpyTransport, bigNumberFormatter } from "@uma/logger";
import { AcrossConfigStore, FakeContract } from "@across-protocol/contracts";
import { constants, utils as sdkUtils } from "@across-protocol/sdk";
import { Contract, providers } from "ethers";
import chai, { assert, expect } from "chai";
import chaiExclude from "chai-exclude";
import sinon from "sinon";
import winston from "winston";
import { GLOBAL_CONFIG_STORE_KEYS } from "../../src/clients";
import {
  Deposit,
  DepositWithBlock,
  Fill,
  FillWithBlock,
  RelayData,
  RelayExecutionEventInfo,
  SlowFillLeaf,
  SlowFillRequest,
} from "../../src/interfaces";
import {
  BigNumber,
  isDefined,
  spreadEvent,
  toBN,
  toBNWei,
  toWei,
  utf8ToHex,
  ZERO_ADDRESS,
  getMessageHash,
  toBytes32,
  toAddressType,
} from "../../src/utils";
import {
  DEFAULT_BLOCK_RANGE_FOR_CHAIN,
  MAX_L1_TOKENS_PER_POOL_REBALANCE_LEAF,
  MAX_REFUNDS_PER_RELAYER_REFUND_LEAF,
  sampleRateModel,
} from "../constants";
import { SpokePoolDeploymentResult, SpyLoggerResult } from "../types";
import { INFINITE_FILL_DEADLINE } from "../../src/common";

// Replicated from @uma/common
const TokenRolesEnum = { OWNER: "0", MINTER: "1", BURNER: "3" };

export {
  SpyTransport,
  bigNumberFormatter,
  lastSpyLogIncludes,
  lastSpyLogLevel,
  spyLogIncludes,
  spyLogLevel,
} from "@uma/logger";
export { MAX_SAFE_ALLOWANCE, MAX_UINT_VAL } from "../../src/utils";
export const {
  ethers,
  buildPoolRebalanceLeafTree,
  buildPoolRebalanceLeaves,
  buildSlowRelayTree,
  buildV3SlowRelayTree,
  createRandomBytes32,
  getContractFactory,
  getUpdatedV3DepositSignature,
  hubPoolFixture,
  modifyRelayHelper,
  randomAddress,
} = utils;

export type SignerWithAddress = utils.SignerWithAddress;
export { assert, chai, expect, BigNumber, Contract, FakeContract, sinon, toBN, toBNWei, toWei, utf8ToHex, winston };

chai.use(chaiExclude);

export async function assertPromiseError<T>(promise: Promise<T>, errMessage?: string): Promise<void> {
  const SPECIAL_ERROR_MESSAGE = "Promise didn't fail";
  try {
    await promise;
    throw new Error(SPECIAL_ERROR_MESSAGE);
  } catch (e: unknown) {
    const err: Error = e as Error;
    if (err.message.includes(SPECIAL_ERROR_MESSAGE)) {
      throw err;
    }
    if (errMessage) {
      assert.isTrue(err.message.includes(errMessage));
    }
  }
}

export async function setupTokensForWallet(
  contractToApprove: Contract,
  wallet: SignerWithAddress,
  tokens: Contract[],
  weth?: Contract,
  seedMultiplier = 1
): Promise<void> {
  const approveToken = async (token: Contract) => {
    const balance = await token.balanceOf(wallet.address);
    await token.connect(wallet).approve(contractToApprove.address, balance);
  };

  await utils.seedWallet(wallet, tokens, weth, utils.amountToSeedWallets.mul(seedMultiplier));
  await Promise.all(tokens.map(approveToken));

  if (weth) {
    await approveToken(weth);
  }
}

export function createSpyLogger(): SpyLoggerResult {
  const spy = sinon.spy();
  const spyLogger = winston.createLogger({
    level: "debug",
    format: winston.format.combine(winston.format(bigNumberFormatter)(), winston.format.json()),
    transports: [
      new SpyTransport({ level: "debug" }, { spy }),
      process.env.LOG_IN_TEST ? new winston.transports.Console() : null,
    ].filter((n) => n),
  });

  return { spy, spyLogger };
}

export async function deploySpokePoolWithToken(fromChainId = 0): Promise<SpokePoolDeploymentResult> {
  const { weth, erc20, spokePool, unwhitelistedErc20, destErc20 } = await utils.deploySpokePool(utils.ethers);
  const receipt = await spokePool.deployTransaction.wait();

  await spokePool.setChainId(fromChainId == 0 ? utils.originChainId : fromChainId);
  return { weth, erc20, spokePool, unwhitelistedErc20, destErc20, deploymentBlock: receipt.blockNumber };
}

export async function deployMulticall3(signer: SignerWithAddress) {
  return sdkUtils.deploy(signer);
}

export async function deployConfigStore(
  signer: SignerWithAddress,
  tokensToAdd: Contract[],
  maxL1TokensPerPoolRebalanceLeaf: number = MAX_L1_TOKENS_PER_POOL_REBALANCE_LEAF,
  maxRefundPerRelayerRefundLeaf: number = MAX_REFUNDS_PER_RELAYER_REFUND_LEAF,
  rateModel: unknown = sampleRateModel,
  additionalChainIdIndices?: number[]
): Promise<{ configStore: AcrossConfigStore; deploymentBlock: number }> {
  const configStore = (await (
    await utils.getContractFactory("AcrossConfigStore", signer)
  ).deploy()) as AcrossConfigStore;
  const { blockNumber: deploymentBlock } = await configStore.deployTransaction.wait();

  for (const token of tokensToAdd) {
    await configStore.updateTokenConfig(
      token.address,
      JSON.stringify({
        rateModel: rateModel,
      })
    );
  }
  await configStore.updateGlobalConfig(
    utf8ToHex(GLOBAL_CONFIG_STORE_KEYS.MAX_POOL_REBALANCE_LEAF_SIZE),
    maxL1TokensPerPoolRebalanceLeaf.toString()
  );
  await configStore.updateGlobalConfig(
    utf8ToHex(GLOBAL_CONFIG_STORE_KEYS.MAX_RELAYER_REPAYMENT_LEAF_SIZE),
    maxRefundPerRelayerRefundLeaf.toString()
  );

  if (additionalChainIdIndices) {
    await configStore.updateGlobalConfig(
      utf8ToHex(GLOBAL_CONFIG_STORE_KEYS.CHAIN_ID_INDICES),
      JSON.stringify([...constants.PROTOCOL_DEFAULT_CHAIN_ID_INDICES, ...additionalChainIdIndices])
    );
  }
  return { configStore, deploymentBlock };
}

export async function deployAndConfigureHubPool(
  signer: SignerWithAddress,
  spokePools: { l2ChainId: number; spokePool: Contract }[],
  finderAddress: string = ZERO_ADDRESS,
  timerAddress: string = ZERO_ADDRESS
): Promise<{
  hubPool: Contract;
  mockAdapter: Contract;
  l1Token_1: Contract;
  l1Token_2: Contract;
  hubPoolDeploymentBlock: number;
}> {
  const lpTokenFactory = await (await utils.getContractFactory("LpTokenFactory", signer)).deploy();
  const hubPool = await (
    await utils.getContractFactory("HubPool", signer)
  ).deploy(lpTokenFactory.address, finderAddress, ZERO_ADDRESS, timerAddress);
  const receipt = await hubPool.deployTransaction.wait();

  const mockAdapter = await (await utils.getContractFactory("Mock_Adapter", signer)).deploy();

  for (const spokePool of spokePools) {
    await hubPool.setCrossChainContracts(spokePool.l2ChainId, mockAdapter.address, spokePool.spokePool.address);
  }

  const l1Token_1 = await (await utils.getContractFactory("ExpandedERC20", signer)).deploy("L1Token1", "L1Token1", 18);
  await l1Token_1.addMember(TokenRolesEnum.MINTER, signer.address);
  const l1Token_2 = await (await utils.getContractFactory("ExpandedERC20", signer)).deploy("L1Token2", "L1Token2", 18);
  await l1Token_2.addMember(TokenRolesEnum.MINTER, signer.address);

  return { hubPool, mockAdapter, l1Token_1, l1Token_2, hubPoolDeploymentBlock: receipt.blockNumber };
}

export async function deployNewTokenMapping(
  l2TokenHolder: SignerWithAddress,
  l1TokenHolder: SignerWithAddress,
  spokePool: Contract,
  spokePoolDestination: Contract,
  configStore: Contract,
  hubPool: Contract,
  amountToSeedLpPool: BigNumber
): Promise<{
  l2Token: Contract;
  l1Token: Contract;
}> {
  // Deploy L2 token and enable it for deposits:
  const spokePoolChainId = await spokePool.chainId();
  const l2Token = await (await utils.getContractFactory("ExpandedERC20", l2TokenHolder)).deploy("L2 Token", "L2", 18);
  await l2Token.addMember(TokenRolesEnum.MINTER, l2TokenHolder.address);

  // Deploy second L2 token that is destination chain's counterpart to L2 token.
  const spokePoolDestinationChainId = await spokePoolDestination.chainId();
  const l2TokenDestination = await (
    await utils.getContractFactory("ExpandedERC20", l2TokenHolder)
  ).deploy("L2 Token Destination", "L2", 18);
  await l2TokenDestination.addMember(TokenRolesEnum.MINTER, l2TokenHolder.address);

  // Deploy L1 token and set as counterpart for L2 token:
  const l1Token = await (await utils.getContractFactory("ExpandedERC20", l1TokenHolder)).deploy("L1 Token", "L1", 18);
  await l1Token.addMember(TokenRolesEnum.MINTER, l1TokenHolder.address);
  await enableRoutesOnHubPool(hubPool, [
    { destinationChainId: spokePoolChainId, l1Token, destinationToken: l2Token },
    { destinationChainId: spokePoolDestinationChainId, l1Token, destinationToken: l2TokenDestination },
  ]);
  await configStore.updateTokenConfig(l1Token.address, JSON.stringify({ rateModel: sampleRateModel }));

  // Give signer initial balance and approve hub pool and spoke pool to pull funds from it
  await addLiquidity(l1TokenHolder, hubPool, l1Token, amountToSeedLpPool);
  await setupTokensForWallet(spokePool, l2TokenHolder, [l2Token, l2TokenDestination], undefined, 100);
  await setupTokensForWallet(spokePoolDestination, l2TokenHolder, [l2TokenDestination, l2Token], undefined, 100);

  // Set time to provider time so blockfinder can find block for deposit quote time.
  await spokePool.setCurrentTime(await getLastBlockTime(spokePool.provider));
  await spokePoolDestination.setCurrentTime(await getLastBlockTime(spokePoolDestination.provider));

  return {
    l2Token,
    l1Token,
  };
}

export async function enableRoutesOnHubPool(
  hubPool: Contract,
  rebalanceRouteTokens: { destinationChainId: number; l1Token: Contract; destinationToken: Contract }[]
): Promise<void> {
  for (const tkn of rebalanceRouteTokens) {
    await hubPool.setPoolRebalanceRoute(tkn.destinationChainId, tkn.l1Token.address, tkn.destinationToken.address);
    await hubPool.enableL1TokenForLiquidityProvision(tkn.l1Token.address);
  }
}

export async function getLastBlockTime(provider: providers.Provider): Promise<number> {
  return (await provider.getBlock(await provider.getBlockNumber())).timestamp;
}

export async function depositV3(
  spokePool: Contract,
  destinationChainId: number,
  signer: SignerWithAddress,
  inputToken: string,
  inputAmount: BigNumber,
  outputToken: string,
  outputAmount: BigNumber,
  opts: {
    destinationChainId?: number;
    recipient?: string;
    quoteTimestamp?: number;
    message?: string;
    fillDeadline?: number;
    exclusivityDeadline?: number;
    exclusiveRelayer?: string;
  } = {}
): Promise<DepositWithBlock> {
  const depositor = signer.address;
  const recipient = opts.recipient ?? depositor;

  const [spokePoolTime, fillDeadlineBuffer] = (
    await Promise.all([spokePool.getCurrentTime(), spokePool.fillDeadlineBuffer()])
  ).map((n) => Number(n));

  const quoteTimestamp = opts.quoteTimestamp ?? spokePoolTime;
  const message = opts.message ?? constants.EMPTY_MESSAGE;
  const fillDeadline = opts.fillDeadline ?? spokePoolTime + fillDeadlineBuffer;
  const isLegacyDeposit = INFINITE_FILL_DEADLINE.eq(fillDeadline);
  const exclusivityDeadline = opts.exclusivityDeadline ?? 0;
  const exclusiveRelayer = opts.exclusiveRelayer ?? ZERO_ADDRESS;

  const [originChainId, txnResponse] = await Promise.all([
    spokePool.chainId(),
    isLegacyDeposit
      ? spokePool
          .connect(signer)
          .depositFor(
            depositor,
            recipient,
            inputToken,
            inputAmount,
            destinationChainId,
            inputAmount.sub(outputAmount).mul(toWei(1)).div(inputAmount),
            quoteTimestamp,
            message,
            0
          )
      : spokePool
          .connect(signer)
          .deposit(
            toBytes32(depositor),
            toBytes32(recipient),
            toBytes32(inputToken),
            toBytes32(outputToken),
            inputAmount,
            outputAmount,
            destinationChainId,
            toBytes32(exclusiveRelayer),
            quoteTimestamp,
            fillDeadline,
            exclusivityDeadline,
            message
          ),
  ]);
  const txnReceipt = await txnResponse.wait();

  const _topic = "FundsDeposited";
  const topic = spokePool.interface.getEventTopic(_topic);
  const eventLog = txnReceipt.logs.find(({ topics: [eventTopic] }) => eventTopic === topic);
  const { args } = spokePool.interface.parseLog(eventLog);
  const { blockNumber, transactionHash: txnRef, transactionIndex: txnIndex } = txnReceipt;
  const { logIndex } = eventLog;

  const depositArgs = spreadEvent(args);
  const depositObject: DepositWithBlock = {
    blockNumber,
    txnRef,
    txnIndex,
    logIndex,
    ...depositFromArgs(depositArgs),
    originChainId: Number(originChainId),
    quoteBlockNumber: 0,
    messageHash: args.messageHash ?? getMessageHash(args.message),
  };

  if (isLegacyDeposit) {
    depositObject.outputToken = toAddressType(outputToken, originChainId);
  }

  return depositObject;
}

export async function updateDeposit(
  spokePool: Contract,
  deposit: Deposit,
  depositor: SignerWithAddress
): Promise<string> {
  const { updatedRecipient: updatedRecipientAddress, updatedOutputAmount, updatedMessage } = deposit;
  if (updatedRecipientAddress === undefined) {
    throw `updateDeposit cannot have updatedRecipientAddress undefined ${depositIntoPrimitiveTypes(deposit)}`;
  }
  const updatedRecipient = updatedRecipientAddress.toBytes32();
  assert.ok(isDefined(updatedRecipient));
  assert.ok(isDefined(updatedOutputAmount));
  assert.ok(isDefined(updatedMessage));
  const signature = await getUpdatedV3DepositSignature(
    depositor,
    deposit.depositId,
    deposit.originChainId,
    updatedOutputAmount!,
    updatedRecipient,
    updatedMessage!
  );

  await spokePool
    .connect(depositor)
    .speedUpDeposit(
      sdkUtils.toBytes32(depositor.address),
      deposit.depositId,
      updatedOutputAmount,
      updatedRecipient,
      updatedMessage,
      signature
    );
  return signature;
}

export async function fillV3Relay(
  spokePool: Contract,
  deposit: Omit<Deposit, "destinationChainId">,
  signer: SignerWithAddress,
  repaymentChainId?: number
): Promise<FillWithBlock> {
  const destinationChainId = Number(await spokePool.chainId());

  await spokePool.connect(signer).fillRelay(
    {
      ...deposit,
      depositor: deposit.depositor.toBytes32(),
      recipient: deposit.recipient.toBytes32(),
      inputToken: deposit.inputToken.toBytes32(),
      outputToken: deposit.outputToken.toBytes32(),
      exclusiveRelayer: deposit.exclusiveRelayer.toBytes32(),
    },
    repaymentChainId ?? destinationChainId,
    toBytes32(await signer.getAddress())
  );

  const events = await spokePool.queryFilter(spokePool.filters.FilledRelay());
  const lastEvent = events.at(-1);
  let args = lastEvent!.args;
  assert.exists(args);
  args = args!;

  const { blockNumber, transactionHash, transactionIndex, logIndex } = lastEvent!;

  const parsedEvent = spreadEvent(args);
  return {
    blockNumber,
    txnRef: transactionHash,
    txnIndex: transactionIndex,
    logIndex,
    ...fillFromArgs({ ...parsedEvent, destinationChainId }),
  };
}

export async function addLiquidity(
  signer: SignerWithAddress,
  hubPool: Contract,
  l1Token: Contract,
  amount: utils.BigNumber
): Promise<void> {
  const weth = undefined;
  await utils.seedWallet(signer, [l1Token], weth, amount);
  await l1Token.connect(signer).approve(hubPool.address, amount);
  await hubPool.enableL1TokenForLiquidityProvision(l1Token.address);
  await hubPool.connect(signer).addLiquidity(l1Token.address, amount);
}

export function buildV3SlowRelayLeaves(deposits: Deposit[], lpFeePct: BigNumber): SlowFillLeaf[] {
  const chainId = deposits[0].destinationChainId;
  assert.isTrue(deposits.every(({ destinationChainId }) => chainId === destinationChainId));
  return deposits
    .map((deposit) => {
      const lpFee = deposit.inputAmount.mul(lpFeePct).div(toBNWei(1));
      const slowFillLeaf: SlowFillLeaf = {
        relayData: {
          depositor: deposit.depositor,
          recipient: deposit.recipient,
          exclusiveRelayer: deposit.exclusiveRelayer,
          inputToken: deposit.inputToken,
          outputToken: deposit.outputToken,
          inputAmount: deposit.inputAmount,
          outputAmount: deposit.outputAmount,
          originChainId: deposit.originChainId,
          depositId: deposit.depositId,
          fillDeadline: deposit.fillDeadline,
          exclusivityDeadline: deposit.exclusivityDeadline,
          message: deposit.message,
        },
        chainId,
        updatedOutputAmount: deposit.inputAmount.sub(lpFee),
      };
      return slowFillLeaf;
    })
    .sort(({ relayData: relayA }, { relayData: relayB }) => {
      if (relayA.originChainId !== relayB.originChainId) {
        return Number(relayA.originChainId) - Number(relayB.originChainId);
      } else {
        return Number(relayA.depositId) - Number(relayB.depositId);
      }
    });
}

// We use the offset input to bypass the bundleClient's cache key, which is the bundle block range. So, to make sure
// that the client requeries fresh blockchain state, we need to slightly offset the block range to produce a different
// cache key.
export function getDefaultBlockRange(toBlockOffset: number): number[][] {
  return DEFAULT_BLOCK_RANGE_FOR_CHAIN.map((range) => [range[0], range[1] + toBlockOffset]);
}

export function getDisabledBlockRanges(): number[][] {
  return DEFAULT_BLOCK_RANGE_FOR_CHAIN.map((range) => [range[0], range[0]]);
}

export function createRefunds(
  outputToken: string,
  refundAmount: BigNumber,
  repaymentToken: string
): { [repaymentToken: string]: { [outputToken: string]: BigNumber } } {
  return {
    [toBytes32(repaymentToken)]: {
      [toBytes32(outputToken)]: refundAmount,
    },
  };
}

// A helper function to parse key - value map into a Fill object
export function fillFromArgs(fillArgs: { [key: string]: any }): Fill {
  const { message, ...relayData } = relayDataFromArgs(fillArgs);
  const { relayExecutionInfo: relayExecutionInfoArgs } = fillArgs;
  const relayExecutionInfo: RelayExecutionEventInfo = {
    updatedRecipient: toAddressType(relayExecutionInfoArgs.updatedRecipient, fillArgs.destinationChainId),
    updatedOutputAmount: relayExecutionInfoArgs.updatedOutputAmount,
    updatedMessageHash: relayExecutionInfoArgs.updatedMessageHash,
    fillType: relayExecutionInfoArgs.fillType,
  };
  if (relayExecutionInfoArgs.updatedMessage) {
    relayExecutionInfo.updatedMessage = relayExecutionInfoArgs.updatedMessage;
  }
  return {
    ...relayData,
    messageHash: fillArgs.messageHash,
    destinationChainId: fillArgs.destinationChainId,
    relayer: toAddressType(fillArgs.relayer, fillArgs.destinationChainId),
    repaymentChainId: fillArgs.repaymentChainId,
    relayExecutionInfo,
  };
}

// decomposes Fill into primitive types suitable for === comparisons
export function fillIntoPrimitiveTypes(fill: Fill) {
  return {
    ...fill,
    inputToken: fill.inputToken.toNative(),
    outputToken: fill.outputToken.toNative(),
    depositor: fill.depositor.toNative(),
    recipient: fill.recipient.toNative(),
    exclusiveRelayer: fill.exclusiveRelayer.toNative(),
    relayer: fill.relayer.toNative(),
    relayExecutionInfo: {
      ...fill.relayExecutionInfo,
      updatedRecipient: fill.relayExecutionInfo.updatedRecipient?.toNative(),
    },
  };
}

export function relayDataFromArgs(relayDataArgs: { [key: string]: any }): RelayData {
  return {
    originChainId: relayDataArgs.originChainId,
    depositor: toAddressType(relayDataArgs.depositor, relayDataArgs.originChainId),
    recipient: toAddressType(relayDataArgs.recipient, relayDataArgs.destinationChainId),
    depositId: relayDataArgs.depositId,
    inputToken: toAddressType(relayDataArgs.inputToken, relayDataArgs.originChainId),
    inputAmount: relayDataArgs.inputAmount,
    outputToken: toAddressType(relayDataArgs.outputToken, relayDataArgs.destinationChainId),
    outputAmount: relayDataArgs.outputAmount,
    message: relayDataArgs.message,
    fillDeadline: relayDataArgs.fillDeadline,
    exclusiveRelayer: toAddressType(relayDataArgs.exclusiveRelayer, relayDataArgs.destinationChainId),
    exclusivityDeadline: relayDataArgs.exclusivityDeadline,
  };
}

export function slowFillRequestFromArgs(slowFillRequestArgs: { [key: string]: any }): SlowFillRequest {
  const { message, ...relayData } = relayDataFromArgs(slowFillRequestArgs);
  return {
    ...relayData,
    destinationChainId: slowFillRequestArgs.destinationChainId,
    messageHash: slowFillRequestArgs.messageHash ?? getMessageHash(slowFillRequestArgs.message),
  };
}

// A helper function to parse key - value map into a Deposit object with correct types (e.g. Address)
export function depositFromArgs(depositArgs: { [key: string]: any }): Deposit {
  const deposit: Deposit = {
    ...relayDataFromArgs(depositArgs),
    destinationChainId: depositArgs.destinationChainId,
    messageHash: depositArgs.messageHash,
    quoteTimestamp: depositArgs.quoteTimestamp,
    fromLiteChain: depositArgs.fromLiteChain,
    toLiteChain: depositArgs.toLiteChain,
  };

  if (depositArgs.speedUpSignature) {
    deposit.speedUpSignature = depositArgs.speedUpSignature;
  }

  if (depositArgs.updatedRecipient) {
    deposit.updatedRecipient = toAddressType(depositArgs.updatedRecipient, depositArgs.destinationChainId);
    deposit.updatedOutputAmount = depositArgs.updatedOutputAmount;
    deposit.updatedMessage = depositArgs.updatedMessage;
  }

  return deposit;
}

// decomposes Deposit into primitive types suitable for === comparisons
export function depositIntoPrimitiveTypes(deposit: Deposit) {
  return {
    ...deposit,
    inputToken: deposit.inputToken.toNative(),
    outputToken: deposit.outputToken.toNative(),
    depositor: deposit.depositor.toNative(),
    recipient: deposit.recipient.toNative(),
    exclusiveRelayer: deposit.exclusiveRelayer.toNative(),
    updatedRecipient: deposit.updatedRecipient?.toNative(),
  };
}
