import * as utils from "@across-protocol/contracts/dist/test-utils";
import { TokenRolesEnum } from "@uma/common";
import { SpyTransport, bigNumberFormatter } from "@uma/logger";
import { AcrossConfigStore, FakeContract } from "@across-protocol/contracts";
import { constants, utils as sdkUtils } from "@across-protocol/sdk";
import { Contract, providers } from "ethers";
import chai, { assert, expect } from "chai";
import chaiExclude from "chai-exclude";
import sinon from "sinon";
import winston from "winston";
import { GLOBAL_CONFIG_STORE_KEYS } from "../../src/clients";
import { Deposit, DepositWithBlock, FillWithBlock, SlowFillLeaf } from "../../src/interfaces";
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
} from "../../src/utils";
import {
  DEFAULT_BLOCK_RANGE_FOR_CHAIN,
  MAX_L1_TOKENS_PER_POOL_REBALANCE_LEAF,
  MAX_REFUNDS_PER_RELAYER_REFUND_LEAF,
  sampleRateModel,
} from "../constants";
import { SpokePoolDeploymentResult, SpyLoggerResult } from "../types";
import { INFINITE_FILL_DEADLINE } from "../../src/common";

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
  enableRoutes,
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

export async function deploySpokePoolWithToken(
  fromChainId = 0,
  toChainId = 0,
  enableRoute = true
): Promise<SpokePoolDeploymentResult> {
  const { weth, erc20, spokePool, unwhitelistedErc20, destErc20 } = await utils.deploySpokePool(utils.ethers);
  const receipt = await spokePool.deployTransaction.wait();

  await spokePool.setChainId(fromChainId == 0 ? utils.originChainId : fromChainId);

  if (enableRoute) {
    await utils.enableRoutes(spokePool, [
      { originToken: erc20.address, destinationChainId: toChainId == 0 ? utils.destinationChainId : toChainId },
      { originToken: weth.address, destinationChainId: toChainId == 0 ? utils.destinationChainId : toChainId },
    ]);
  }
  return { weth, erc20, spokePool, unwhitelistedErc20, destErc20, deploymentBlock: receipt.blockNumber };
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

  await utils.enableRoutes(spokePoolDestination, [
    { originToken: l2TokenDestination.address, destinationChainId: spokePoolChainId },
  ]);
  await utils.enableRoutes(spokePool, [
    { originToken: l2Token.address, destinationChainId: spokePoolDestinationChainId },
  ]);

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
  await setupTokensForWallet(spokePool, l2TokenHolder, [l2Token, l2TokenDestination], null, 100);
  await setupTokensForWallet(spokePoolDestination, l2TokenHolder, [l2TokenDestination, l2Token], null, 100);

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
          .depositV3(
            depositor,
            recipient,
            inputToken,
            outputToken,
            inputAmount,
            outputAmount,
            destinationChainId,
            exclusiveRelayer,
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
  const { blockNumber, transactionHash, transactionIndex } = txnReceipt;
  const { logIndex } = eventLog;

  const depositObject = {
    originChainId: Number(originChainId),
    blockNumber,
    transactionHash,
    transactionIndex,
    logIndex,
    ...spreadEvent(args),
    messageHash: args.messageHash ?? getMessageHash(args.message),
  };
  if (isLegacyDeposit) {
    depositObject.outputToken = outputToken;
  }
  return depositObject;
}

export async function updateDeposit(
  spokePool: Contract,
  deposit: Deposit,
  depositor: SignerWithAddress
): Promise<string> {
  const { updatedRecipient: updatedRecipientAddress, updatedOutputAmount, updatedMessage } = deposit;
  const updatedRecipient = sdkUtils.toBytes32(updatedRecipientAddress!);
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
  assert.notEqual(deposit.originChainId, destinationChainId);

  await spokePool.connect(signer).fillV3Relay(deposit, repaymentChainId ?? destinationChainId);

  const events = await spokePool.queryFilter(spokePool.filters.FilledRelay());
  const lastEvent = events.at(-1);
  let args = lastEvent!.args;
  assert.exists(args);
  args = args!;

  const { blockNumber, transactionHash, transactionIndex, logIndex } = lastEvent!;

  const parsedEvent = spreadEvent(args);
  return {
    destinationChainId,
    blockNumber,
    transactionHash,
    transactionIndex,
    logIndex,
    ...parsedEvent,
    messageHash: args.messageHash ?? getMessageHash(args.message),
    relayExecutionInfo: {
      ...parsedEvent.relayExecutionInfo,
      updatedMessageHash: getMessageHash(parsedEvent.relayExecutionInfo.updatedMessage),
    },
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

export function buildV3SlowRelayLeaves(deposits: interfaces.Deposit[], lpFeePct: BigNumber): SlowFillLeaf[] {
  const chainId = deposits[0].destinationChainId;
  assert.isTrue(deposits.every(({ destinationChainId }) => chainId === destinationChainId));
  return deposits
    .map((deposit) => {
      const lpFee = deposit.inputAmount.mul(lpFeePct).div(toBNWei(1));
      const slowFillLeaf: SlowFillLeaf = {
        relayData: {
          depositor: sdkUtils.toBytes32(deposit.depositor),
          recipient: sdkUtils.toBytes32(deposit.recipient),
          exclusiveRelayer: sdkUtils.toBytes32(deposit.exclusiveRelayer),
          inputToken: sdkUtils.toBytes32(deposit.inputToken),
          outputToken: sdkUtils.toBytes32(deposit.outputToken),
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
    [repaymentToken]: {
      [outputToken]: refundAmount,
    },
  };
}
