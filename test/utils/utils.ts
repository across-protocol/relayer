import * as utils from "@across-protocol/contracts-v2/dist/test-utils";
import { TokenRolesEnum } from "@uma/common";
import { SpyTransport, bigNumberFormatter } from "@uma/financial-templates-lib";
import { AcrossConfigStore, FakeContract, MerkleTree } from "@across-protocol/contracts-v2";
import { constants, utils as sdkUtils } from "@across-protocol/sdk-v2";
import { BigNumber, Contract, providers } from "ethers";
import chai, { assert, expect } from "chai";
import chaiExclude from "chai-exclude";
import _ from "lodash";
import sinon from "sinon";
import winston from "winston";
import { ConfigStoreClient, GLOBAL_CONFIG_STORE_KEYS, HubPoolClient } from "../../src/clients";
import {
  Deposit,
  Fill,
  RelayerRefundLeaf,
  RunningBalances,
  V2Deposit,
  V3DepositWithBlock,
  V3SlowFillLeaf,
} from "../../src/interfaces";
import { buildRelayerRefundTree, toBN, toBNWei, toWei, utf8ToHex, ZERO_ADDRESS } from "../../src/utils";
import {
  DEFAULT_BLOCK_RANGE_FOR_CHAIN,
  MAX_L1_TOKENS_PER_POOL_REBALANCE_LEAF,
  MAX_REFUNDS_PER_RELAYER_REFUND_LEAF,
  amountToDeposit,
  depositRelayerFeePct,
  sampleRateModel,
} from "../constants";
import { ContractsV2SlowFill, SpokePoolDeploymentResult, SpyLoggerResult } from "../types";

export {
  SpyTransport,
  bigNumberFormatter,
  lastSpyLogIncludes,
  lastSpyLogLevel,
  spyLogIncludes,
  spyLogLevel,
} from "@uma/financial-templates-lib";
export { MAX_SAFE_ALLOWANCE, MAX_UINT_VAL } from "../../src/utils";
export const {
  ethers,
  buildPoolRebalanceLeafTree,
  buildPoolRebalanceLeaves,
  buildSlowRelayTree,
  buildV3SlowRelayTree,
  createRandomBytes32,
  depositV2,
  enableRoutes,
  getContractFactory,
  getUpdatedV3DepositSignature,
  hubPoolFixture,
  modifyRelayHelper,
  randomAddress,
} = utils;
export const { getV3RelayHash } = sdkUtils;

export type SignerWithAddress = utils.SignerWithAddress;
export { assert, chai, expect, BigNumber, Contract, FakeContract, sinon, toBN, toBNWei, toWei, utf8ToHex, winston };

chai.use(chaiExclude);

export function deepEqualsWithBigNumber(x: unknown, y: unknown, omitKeys: string[] = []): boolean {
  if (x === undefined || y === undefined) {
    return false;
  }
  const sortedKeysX = Object.fromEntries(
    Object.keys(x)
      .sort()
      .map((key) => [key, x[key]])
  );
  const sortedKeysY = Object.fromEntries(
    Object.keys(y)
      .sort()
      .map((key) => [key, y[key]])
  );
  assert.deepStrictEqual(_.omit(sortedKeysX, omitKeys), _.omit(sortedKeysY, omitKeys));
  return true;
}

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

export async function simpleDeposit(
  spokePool: Contract,
  token: Contract,
  recipient: SignerWithAddress,
  depositor: SignerWithAddress,
  destinationChainId: number = utils.destinationChainId,
  amountToDeposit: utils.BigNumber = utils.amountToDeposit,
  depositRelayerFeePct: utils.BigNumber = utils.depositRelayerFeePct
): Promise<Deposit> {
  const depositObject = await utils.depositV2(
    spokePool,
    token,
    recipient,
    depositor,
    destinationChainId,
    amountToDeposit,
    depositRelayerFeePct
  );
  return {
    ...depositObject,
    realizedLpFeePct: toBNWei("0"),
    destinationToken: ZERO_ADDRESS,
  };
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
): Promise<V3DepositWithBlock> {
  const depositor = signer.address;
  const recipient = opts.recipient ?? depositor;

  const [spokePoolTime, fillDeadlineBuffer] = (
    await Promise.all([spokePool.getCurrentTime(), spokePool.fillDeadlineBuffer()])
  ).map((n) => Number(n));

  const quoteTimestamp = opts.quoteTimestamp ?? spokePoolTime;
  const message = opts.message ?? constants.EMPTY_MESSAGE;
  const fillDeadline = opts.fillDeadline ?? spokePoolTime + fillDeadlineBuffer;
  const exclusivityDeadline = opts.exclusivityDeadline ?? 0;
  const exclusiveRelayer = opts.exclusiveRelayer ?? ZERO_ADDRESS;

  await spokePool
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
    );

  const [events, originChainId] = await Promise.all([
    spokePool.queryFilter(spokePool.filters.V3FundsDeposited()),
    spokePool.chainId(),
  ]);

  const lastEvent = events.at(-1);
  let args = lastEvent?.args;
  assert.exists(args);
  args = args!; // tsc coersion

  const { blockNumber, transactionHash, transactionIndex, logIndex } = lastEvent!;

  return {
    depositId: args.depositId,
    originChainId: Number(originChainId),
    destinationChainId: Number(args.destinationChainId),
    depositor: args.depositor,
    recipient: args.recipient,
    inputToken: args.inputToken,
    inputAmount: args.inputAmount,
    outputToken: args.outputToken,
    outputAmount: args.outputAmount,
    quoteTimestamp: args.quoteTimestamp,
    message: args.message,
    fillDeadline: args.fillDeadline,
    exclusivityDeadline: args.exclusivityDeadline,
    exclusiveRelayer: args.exclusiveRelayer,
    quoteBlockNumber: 0, // @todo
    blockNumber,
    transactionHash,
    transactionIndex,
    logIndex,
  };
}

export async function addLiquidity(
  signer: SignerWithAddress,
  hubPool: Contract,
  l1Token: Contract,
  amount: utils.BigNumber
): Promise<void> {
  await utils.seedWallet(signer, [l1Token], null, amount);
  await l1Token.connect(signer).approve(hubPool.address, amount);
  await hubPool.enableL1TokenForLiquidityProvision(l1Token.address);
  await hubPool.connect(signer).addLiquidity(l1Token.address, amount);
}

// Submits a deposit transaction and returns the Deposit struct that that clients interact with.
export async function buildDepositStruct(
  deposit: Omit<V2Deposit, "destinationToken" | "realizedLpFeePct">,
  hubPoolClient: HubPoolClient
): Promise<V2Deposit & { quoteBlockNumber: number; blockNumber: number }> {
  const { quoteBlock, realizedLpFeePct } = await hubPoolClient.computeRealizedLpFeePct({
    ...deposit,
    paymentChainId: deposit.destinationChainId,
  });

  return {
    ...deposit,
    destinationToken: hubPoolClient.getL2TokenForDeposit({ ...deposit, quoteBlockNumber: quoteBlock }),
    quoteBlockNumber: quoteBlock,
    realizedLpFeePct,
    blockNumber: await getLastBlockNumber(),
  };
}

export async function buildDeposit(
  hubPoolClient: HubPoolClient,
  spokePool: Contract,
  tokenToDeposit: Contract,
  l1TokenForDepositedToken: Contract,
  recipientAndDepositor: SignerWithAddress,
  destinationChainId: number,
  amount = amountToDeposit,
  relayerFeePct = depositRelayerFeePct,
  quoteTimestamp?: number,
  message?: string
): Promise<V2Deposit> {
  const _deposit = await utils.depositV2(
    spokePool,
    tokenToDeposit,
    recipientAndDepositor,
    recipientAndDepositor,
    destinationChainId,
    amount,
    relayerFeePct,
    quoteTimestamp,
    message
  );

  // Sanity Check: Ensure that the deposit was successful.
  expect(_deposit).to.not.be.null;
  return await buildDepositStruct(_deposit, hubPoolClient);
}

// Submits a fillRelay transaction and returns the Fill struct that that clients will interact with.
export async function buildFill(
  spokePool: Contract,
  destinationToken: Contract,
  recipientAndDepositor: SignerWithAddress,
  relayer: SignerWithAddress,
  deposit: Deposit,
  pctOfDepositToFill: number,
  repaymentChainId?: number
): Promise<Fill> {
  await spokePool.connect(relayer).fillRelay(
    ...utils.getFillRelayParams(
      utils.getRelayHash(
        recipientAndDepositor.address,
        recipientAndDepositor.address,
        deposit.depositId,
        deposit.originChainId,
        deposit.destinationChainId,
        destinationToken.address,
        deposit.amount,
        deposit.realizedLpFeePct,
        deposit.relayerFeePct
      ).relayData,
      deposit.amount
        .mul(toBNWei(1).sub(deposit.realizedLpFeePct.add(deposit.relayerFeePct)))
        .mul(toBNWei(pctOfDepositToFill))
        .div(toBNWei(1))
        .div(toBNWei(1)),
      repaymentChainId ?? deposit.destinationChainId
    )
  );
  const [events, destinationChainId] = await Promise.all([
    spokePool.queryFilter(spokePool.filters.FilledRelay()),
    spokePool.chainId(),
  ]);
  const lastEvent = events[events.length - 1];
  if (!lastEvent?.args) {
    throw new Error("No FilledRelay event emitted");
  }
  return {
    amount: lastEvent.args.amount,
    totalFilledAmount: lastEvent.args.totalFilledAmount,
    fillAmount: lastEvent.args.fillAmount,
    repaymentChainId: Number(lastEvent.args.repaymentChainId),
    originChainId: Number(lastEvent.args.originChainId),
    relayerFeePct: lastEvent.args.relayerFeePct,
    realizedLpFeePct: lastEvent.args.realizedLpFeePct,
    depositId: lastEvent.args.depositId,
    destinationToken: lastEvent.args.destinationToken,
    relayer: lastEvent.args.relayer,
    depositor: lastEvent.args.depositor,
    recipient: lastEvent.args.recipient,
    message: lastEvent.args.message,
    updatableRelayData: {
      recipient: lastEvent.args.updatableRelayData[0],
      message: lastEvent.args.updatableRelayData[1],
      relayerFeePct: toBN(lastEvent.args.updatableRelayData[2]),
      isSlowRelay: lastEvent.args.updatableRelayData[3],
      payoutAdjustmentPct: toBN(lastEvent.args.updatableRelayData[4]),
    },
    destinationChainId: Number(destinationChainId),
  };
}

export async function buildModifiedFill(
  spokePool: Contract,
  depositor: SignerWithAddress,
  relayer: SignerWithAddress,
  fillToBuildFrom: Fill,
  multipleOfOriginalRelayerFeePct: number,
  pctOfDepositToFill: number,
  newRecipient?: string,
  newMessage?: string
): Promise<Fill> {
  const relayDataFromFill = {
    depositor: fillToBuildFrom.depositor,
    recipient: fillToBuildFrom.recipient,
    destinationToken: fillToBuildFrom.destinationToken,
    amount: fillToBuildFrom.amount,
    originChainId: fillToBuildFrom.originChainId.toString(),
    destinationChainId: fillToBuildFrom.destinationChainId.toString(),
    realizedLpFeePct: fillToBuildFrom.realizedLpFeePct,
    relayerFeePct: fillToBuildFrom.relayerFeePct,
    depositId: fillToBuildFrom.depositId.toString(),
    message: fillToBuildFrom.message,
  };

  const { signature } = await utils.modifyRelayHelper(
    fillToBuildFrom.relayerFeePct.mul(multipleOfOriginalRelayerFeePct),
    fillToBuildFrom.depositId.toString(),
    fillToBuildFrom.originChainId.toString(),
    depositor,
    newRecipient ?? relayDataFromFill.recipient,
    newMessage ?? relayDataFromFill.message
  );
  const updatedRelayerFeePct = fillToBuildFrom.relayerFeePct.mul(multipleOfOriginalRelayerFeePct);
  await spokePool.connect(relayer).fillRelayWithUpdatedDeposit(
    ...utils.getFillRelayUpdatedFeeParams(
      relayDataFromFill,
      fillToBuildFrom.amount
        .mul(toBNWei(1).sub(fillToBuildFrom.realizedLpFeePct.add(updatedRelayerFeePct)))
        .mul(toBNWei(pctOfDepositToFill))
        .div(toBNWei(1))
        .div(toBNWei(1)),
      updatedRelayerFeePct,
      signature,
      Number(relayDataFromFill.destinationChainId),
      newRecipient ?? relayDataFromFill.recipient,
      newMessage ?? relayDataFromFill.message
    )
  );
  const [events, destinationChainId] = await Promise.all([
    spokePool.queryFilter(spokePool.filters.FilledRelay()),
    spokePool.chainId(),
  ]);
  const lastEvent = events[events.length - 1];
  if (lastEvent.args) {
    return {
      amount: lastEvent.args.amount,
      totalFilledAmount: lastEvent.args.totalFilledAmount,
      fillAmount: lastEvent.args.fillAmount,
      repaymentChainId: Number(lastEvent.args.repaymentChainId),
      originChainId: Number(lastEvent.args.originChainId),
      relayerFeePct: lastEvent.args.relayerFeePct,
      realizedLpFeePct: lastEvent.args.realizedLpFeePct,
      depositId: lastEvent.args.depositId,
      destinationToken: lastEvent.args.destinationToken,
      relayer: lastEvent.args.relayer,
      message: lastEvent.args.message,
      depositor: lastEvent.args.depositor,
      recipient: lastEvent.args.recipient,
      updatableRelayData: lastEvent.args.updatableRelayData,
      destinationChainId: Number(destinationChainId),
    };
  } else {
    return null;
  }
}

export async function buildFillForRepaymentChain(
  spokePool: Contract,
  relayer: SignerWithAddress,
  depositToFill: Deposit,
  pctOfDepositToFill: number,
  repaymentChainId: number,
  destinationToken: string = depositToFill.destinationToken
): Promise<Fill> {
  const relayDataFromDeposit = {
    depositor: depositToFill.depositor,
    recipient: depositToFill.recipient,
    destinationToken,
    amount: depositToFill.amount,
    originChainId: depositToFill.originChainId.toString(),
    destinationChainId: depositToFill.destinationChainId.toString(),
    realizedLpFeePct: depositToFill.realizedLpFeePct,
    relayerFeePct: depositToFill.relayerFeePct,
    depositId: depositToFill.depositId.toString(),
  };
  await spokePool.connect(relayer).fillRelay(
    ...utils.getFillRelayParams(
      relayDataFromDeposit,
      depositToFill.amount
        .mul(toBNWei(1).sub(depositToFill.realizedLpFeePct.add(depositToFill.relayerFeePct)))
        .mul(toBNWei(pctOfDepositToFill))
        .div(toBNWei(1))
        .div(toBNWei(1)),
      repaymentChainId
    )
  );
  const [events, destinationChainId] = await Promise.all([
    spokePool.queryFilter(spokePool.filters.FilledRelay()),
    spokePool.chainId(),
  ]);
  const lastEvent = events[events.length - 1];
  if (lastEvent.args) {
    return {
      amount: lastEvent.args.amount,
      totalFilledAmount: lastEvent.args.totalFilledAmount,
      fillAmount: lastEvent.args.fillAmount,
      repaymentChainId: Number(lastEvent.args.repaymentChainId),
      originChainId: Number(lastEvent.args.originChainId),
      relayerFeePct: lastEvent.args.relayerFeePct,
      realizedLpFeePct: lastEvent.args.realizedLpFeePct,
      depositId: lastEvent.args.depositId,
      destinationToken: lastEvent.args.destinationToken,
      relayer: lastEvent.args.relayer,
      message: lastEvent.args.message,
      depositor: lastEvent.args.depositor,
      recipient: lastEvent.args.recipient,
      updatableRelayData: lastEvent.args.updatableRelayData,
      destinationChainId: Number(destinationChainId),
    };
  } else {
    return null;
  }
}

// Returns expected leaves ordered by origin chain ID and then deposit ID(ascending). Ordering is implemented
// same way that dataworker orders them.
export function buildSlowRelayLeaves(
  deposits: Deposit[],
  payoutAdjustmentPcts: BigNumber[] = []
): ContractsV2SlowFill[] {
  return deposits
    .map((_deposit, i) => {
      return {
        relayData: {
          depositor: _deposit.depositor,
          recipient: _deposit.recipient,
          destinationToken: _deposit.destinationToken,
          amount: _deposit.amount,
          originChainId: _deposit.originChainId.toString(),
          destinationChainId: _deposit.destinationChainId.toString(),
          realizedLpFeePct: _deposit.realizedLpFeePct,
          relayerFeePct: _deposit.relayerFeePct,
          depositId: _deposit.depositId.toString(),
          message: _deposit.message,
        },
        payoutAdjustmentPct: BigNumber.from(payoutAdjustmentPcts[i]?.toString() ?? "0"),
      };
    }) // leaves should be ordered by origin chain ID and then deposit ID (ascending).
    .sort(({ relayData: relayA }, { relayData: relayB }) => {
      if (relayA.originChainId !== relayB.originChainId) {
        return Number(relayA.originChainId) - Number(relayB.originChainId);
      } else {
        return Number(relayA.depositId) - Number(relayB.depositId);
      }
    });
}

export function buildV3SlowRelayLeaves(deposits: interfaces.V3Deposit[], lpFeePct: BigNumber): V3SlowFillLeaf[] {
  const chainId = deposits[0].destinationChainId;
  assert.isTrue(deposits.every(({ destinationChainId }) => chainId === destinationChainId));
  return deposits
    .map((deposit) => {
      const lpFee = deposit.inputAmount.mul(lpFeePct).div(toBNWei(1));
      const slowFillLeaf: V3SlowFillLeaf = {
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

// Adds `leafId` to incomplete input `leaves` and then constructs a relayer refund leaf tree.
export async function buildRelayerRefundTreeWithUnassignedLeafIds(
  leaves: {
    chainId: number;
    amountToReturn: BigNumber;
    l2TokenAddress: string;
    refundAddresses: string[];
    refundAmounts: BigNumber[];
  }[]
): Promise<MerkleTree<RelayerRefundLeaf>> {
  return buildRelayerRefundTree(
    leaves.map((leaf, id) => {
      return { ...leaf, leafId: id };
    })
  );
}

export async function constructPoolRebalanceTree(
  runningBalances: RunningBalances,
  realizedLpFees: RunningBalances
): Promise<{
  leaves: utils.PoolRebalanceLeaf[];
  tree: MerkleTree<utils.PoolRebalanceLeaf>;
  startingRunningBalances: utils.BigNumber;
}> {
  const leaves = utils.buildPoolRebalanceLeaves(
    Object.keys(runningBalances).map((x) => Number(x)), // Where funds are getting sent.
    Object.values(runningBalances).map((runningBalanceForL1Token) => Object.keys(runningBalanceForL1Token)), // l1Tokens.
    Object.values(realizedLpFees).map((realizedLpForL1Token) => Object.values(realizedLpForL1Token)), // bundleLpFees.
    Object.values(runningBalances).map((_) => Object.values(_).map(() => toBNWei(-100))), // netSendAmounts.
    Object.values(runningBalances).map((_) => Object.values(_).map(() => toBNWei(100))), // runningBalances.
    Object.keys(runningBalances).map(() => 0) // group index
  );
  const tree = await utils.buildPoolRebalanceLeafTree(leaves);

  return { leaves, tree, startingRunningBalances: toBNWei(100) };
}

export async function buildSlowFill(
  spokePool: Contract,
  lastFillForDeposit: Fill,
  relayer: SignerWithAddress,
  proof: string[],
  rootBundleId = "0"
): Promise<Fill> {
  await spokePool
    .connect(relayer)
    .executeSlowRelayLeaf(
      lastFillForDeposit.depositor,
      lastFillForDeposit.recipient,
      lastFillForDeposit.destinationToken,
      lastFillForDeposit.amount.toString(),
      lastFillForDeposit.originChainId.toString(),
      lastFillForDeposit.realizedLpFeePct.toString(),
      lastFillForDeposit.relayerFeePct.toString(),
      lastFillForDeposit.depositId.toString(),
      rootBundleId,
      lastFillForDeposit.message,
      "0",
      proof
    );
  return {
    ...lastFillForDeposit,
    totalFilledAmount: lastFillForDeposit.amount, // Slow relay always fully fills deposit
    fillAmount: lastFillForDeposit.amount.sub(lastFillForDeposit.totalFilledAmount), // Fills remaining after latest fill for deposit
    updatableRelayData: {
      relayerFeePct: toBN(0),
      isSlowRelay: true,
      recipient: lastFillForDeposit.recipient,
      message: lastFillForDeposit.message,
      payoutAdjustmentPct: toBN(0),
    },
    repaymentChainId: 0, // Always set to 0 for slow fills
    relayer: relayer.address, // Set to caller of `executeSlowRelayLeaf`
  };
}

// We use the offset input to bypass the bundleClient's cache key, which is the bundle block range. So, to make sure
// that the client requeries fresh blockchain state, we need to slightly offset the block range to produce a different
// cache key.
export function getDefaultBlockRange(toBlockOffset: number): number[][] {
  return DEFAULT_BLOCK_RANGE_FOR_CHAIN.map((range) => [range[0], range[1] + toBlockOffset]);
}

export function createRefunds(
  address: string,
  refundAmount: BigNumber,
  token: string
): Record<
  string,
  {
    refunds: Record<string, BigNumber>;
    fills: Fill[];
    totalRefundAmount: BigNumber;
    realizedLpFees: BigNumber;
  }
> {
  return {
    [token]: {
      refunds: { [address]: refundAmount },
      fills: [],
      totalRefundAmount: toBN(0),
      realizedLpFees: toBN(0),
    },
  };
}

/**
 * Grabs the latest block number from the hardhat provider.
 * @returns The latest block number.
 */
export function getLastBlockNumber(): Promise<number> {
  return (utils.ethers.provider as providers.Provider).getBlockNumber();
}

export function convertMockedConfigClient(client: unknown): client is ConfigStoreClient {
  return true;
}
