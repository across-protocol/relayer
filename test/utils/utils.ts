import * as utils from "@across-protocol/contracts-v2/dist/test-utils";

import { TokenRolesEnum } from "@uma/common";
import { SpyTransport, bigNumberFormatter } from "@uma/financial-templates-lib";
import { constants as ethersConstants, providers } from "ethers";
import { GLOBAL_CONFIG_STORE_KEYS, HubPoolClient } from "../../src/clients";
import { Deposit, Fill, FillWithBlock, RunningBalances } from "../../src/interfaces";
import { TransactionResponse, buildRelayerRefundTree, toBN, toBNWei, utf8ToHex } from "../../src/utils";
import {
  DEFAULT_BLOCK_RANGE_FOR_CHAIN,
  DEFAULT_POOL_BALANCE_TOKEN_TRANSFER_THRESHOLD,
  MAX_L1_TOKENS_PER_POOL_REBALANCE_LEAF,
  MAX_REFUNDS_PER_RELAYER_REFUND_LEAF,
  amountToDeposit,
  depositRelayerFeePct,
  l1TokenTransferThreshold,
  sampleRateModel,
  zeroAddress,
} from "../constants";
import { BigNumber, Contract, SignerWithAddress, deposit } from "./index";
export { MAX_SAFE_ALLOWANCE, MAX_UINT_VAL } from "@uma/common";
export { sinon, winston };

import { AcrossConfigStore } from "@across-protocol/contracts-v2";
import { constants } from "@across-protocol/sdk-v2";
import chai, { expect } from "chai";
import chaiExclude from "chai-exclude";
import _ from "lodash";
import sinon from "sinon";
import winston from "winston";
import { SpokePoolDeploymentResult, SpyLoggerResult } from "../types";

chai.use(chaiExclude);

const assert = chai.assert;
export { assert, chai };

export function deepEqualsWithBigNumber(
  x: Iterable<unknown> | Record<string | number, unknown>,
  y: Iterable<unknown> | Record<string | number, unknown>,
  omitKeys: string[] = []
): boolean {
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
  contractToApprove: utils.Contract,
  wallet: utils.SignerWithAddress,
  tokens: utils.Contract[],
  weth?: utils.Contract,
  seedMultiplier = 1
): Promise<void> {
  await utils.seedWallet(wallet, tokens, weth, utils.amountToSeedWallets.mul(seedMultiplier));
  await Promise.all(
    tokens.map((token) =>
      token.connect(wallet).approve(contractToApprove.address, utils.amountToDeposit.mul(seedMultiplier))
    )
  );
  if (weth) {
    await weth.connect(wallet).approve(contractToApprove.address, utils.amountToDeposit);
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
  signer: utils.SignerWithAddress,
  tokensToAdd: utils.Contract[],
  maxL1TokensPerPoolRebalanceLeaf: number = MAX_L1_TOKENS_PER_POOL_REBALANCE_LEAF,
  maxRefundPerRelayerRefundLeaf: number = MAX_REFUNDS_PER_RELAYER_REFUND_LEAF,
  rateModel: unknown = sampleRateModel,
  transferThreshold: BigNumber = DEFAULT_POOL_BALANCE_TOKEN_TRANSFER_THRESHOLD,
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
        transferThreshold: transferThreshold.toString(),
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
  signer: utils.SignerWithAddress,
  spokePools: { l2ChainId: number; spokePool: utils.Contract }[],
  finderAddress: string = zeroAddress,
  timerAddress: string = zeroAddress
) {
  const lpTokenFactory = await (await utils.getContractFactory("LpTokenFactory", signer)).deploy();
  const hubPool = await (
    await utils.getContractFactory("HubPool", signer)
  ).deploy(lpTokenFactory.address, finderAddress, zeroAddress, timerAddress);
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
  l2TokenHolder: utils.SignerWithAddress,
  l1TokenHolder: utils.SignerWithAddress,
  spokePool: utils.Contract,
  spokePoolDestination: utils.Contract,
  configStore: utils.Contract,
  hubPool: utils.Contract,
  amountToSeedLpPool: BigNumber
) {
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
  await configStore.updateTokenConfig(
    l1Token.address,
    JSON.stringify({ rateModel: sampleRateModel, transferThreshold: l1TokenTransferThreshold.toString() })
  );

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
  hubPool: utils.Contract,
  rebalanceRouteTokens: { destinationChainId: number; l1Token: utils.Contract; destinationToken: utils.Contract }[]
) {
  for (const tkn of rebalanceRouteTokens) {
    await hubPool.setPoolRebalanceRoute(tkn.destinationChainId, tkn.l1Token.address, tkn.destinationToken.address);
    await hubPool.enableL1TokenForLiquidityProvision(tkn.l1Token.address);
  }
}

export async function simpleDeposit(
  spokePool: utils.Contract,
  token: utils.Contract,
  recipient: utils.SignerWithAddress,
  depositor: utils.SignerWithAddress,
  destinationChainId: number = utils.destinationChainId,
  amountToDeposit: utils.BigNumber = utils.amountToDeposit,
  depositRelayerFeePct: utils.BigNumber = utils.depositRelayerFeePct
) {
  const depositObject = await utils.deposit(
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
    destinationToken: zeroAddress,
    message: "0x",
  };
}

/**
 * Takes as input a body and returns a new object with the body and a message property. Used to appease the typescript
 * compiler when we want to return a type that doesn't have a message property.
 * @param body Typically a partial structure of a Deposit or Fill.
 * @returns A new object with the body and a message property.
 */
export function appendMessageToResult<T>(body: T): T & { message: string } {
  return { ...body, message: "" };
}

export async function getLastBlockTime(provider: any) {
  return (await provider.getBlock(await provider.getBlockNumber())).timestamp;
}

export async function addLiquidity(
  signer: utils.SignerWithAddress,
  hubPool: utils.Contract,
  l1Token: utils.Contract,
  amount: utils.BigNumber
) {
  await utils.seedWallet(signer, [l1Token], null, amount);
  await l1Token.connect(signer).approve(hubPool.address, amount);
  await hubPool.enableL1TokenForLiquidityProvision(l1Token.address);
  await hubPool.connect(signer).addLiquidity(l1Token.address, amount);
}

// Submits a deposit transaction and returns the Deposit struct that that clients interact with.
export async function buildDepositStruct(
  deposit: Omit<Deposit, "destinationToken" | "realizedLpFeePct">,
  hubPoolClient: HubPoolClient,
  l1TokenForDepositedToken: Contract
) {
  const { quoteBlock, realizedLpFeePct } = await hubPoolClient.computeRealizedLpFeePct(
    {
      ...deposit,
      blockNumber: (await hubPoolClient.blockFinder.getBlockForTimestamp(deposit.quoteTimestamp)).number,
    },
    l1TokenForDepositedToken.address
  );
  return {
    ...deposit,
    message: "0x",
    destinationToken: hubPoolClient.getDestinationTokenForDeposit(deposit),
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
  _destinationChainId: number,
  _amountToDeposit: BigNumber = amountToDeposit,
  _relayerFeePct: BigNumber = depositRelayerFeePct
): Promise<Deposit> {
  const _deposit = await deposit(
    spokePool,
    tokenToDeposit,
    recipientAndDepositor,
    recipientAndDepositor,
    _destinationChainId,
    _amountToDeposit,
    _relayerFeePct
  );
  // Sanity Check: Ensure that the deposit was successful.
  expect(_deposit).to.not.be.null;
  return await buildDepositStruct(appendMessageToResult(_deposit), hubPoolClient, l1TokenForDepositedToken);
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
      appendMessageToResult(relayDataFromDeposit),
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

export async function buildRefundRequest(
  spokePool: Contract,
  relayer: SignerWithAddress,
  fill: FillWithBlock,
  refundToken: string,
  maxCount?: BigNumber
): Promise<TransactionResponse> {
  // @note: These chainIds should align, but don't! @todo: Fix!
  // const chainId = (await spokePool.provider.getNetwork()).chainId;
  // assert.isTrue(fill.repaymentChainId === chainId);

  const {
    originChainId,
    depositId,
    destinationChainId,
    fillAmount: amount,
    realizedLpFeePct,
    blockNumber: fillBlock,
  } = fill;

  maxCount ??= ethersConstants.MaxUint256;

  const refundRequest = await spokePool
    .connect(relayer)
    .requestRefund(
      refundToken,
      amount,
      originChainId,
      destinationChainId,
      realizedLpFeePct,
      depositId,
      fillBlock,
      maxCount
    );

  return refundRequest;
}

// Returns expected leaves ordered by origin chain ID and then deposit ID(ascending). Ordering is implemented
// same way that dataworker orders them.
export function buildSlowRelayLeaves(deposits: Deposit[], payoutAdjustmentPcts: BigNumber[] = []) {
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
        payoutAdjustmentPct: payoutAdjustmentPcts[i]?.toString() ?? "0",
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

// Adds `leafId` to incomplete input `leaves` and then constructs a relayer refund leaf tree.
export async function buildRelayerRefundTreeWithUnassignedLeafIds(
  leaves: {
    chainId: number;
    amountToReturn: BigNumber;
    l2TokenAddress: string;
    refundAddresses: string[];
    refundAmounts: BigNumber[];
  }[]
) {
  return await buildRelayerRefundTree(
    leaves.map((leaf, id) => {
      return { ...leaf, leafId: id };
    })
  );
}

export async function constructPoolRebalanceTree(runningBalances: RunningBalances, realizedLpFees: RunningBalances) {
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
export function getDefaultBlockRange(toBlockOffset: number) {
  return DEFAULT_BLOCK_RANGE_FOR_CHAIN.map((range) => [range[0], range[1] + toBlockOffset]);
}

export function createRefunds(address: string, refundAmount: BigNumber, token: string) {
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
