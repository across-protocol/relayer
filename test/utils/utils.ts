import * as utils from "@across-protocol/contracts-v2/dist/test-utils";
import { TokenRolesEnum } from "@uma/common";
export { MAX_SAFE_ALLOWANCE, MAX_UINT_VAL } from "@uma/common";
import { SpyTransport, bigNumberFormatter } from "@uma/financial-templates-lib";
import {
  sampleRateModel,
  DEFAULT_POOL_BALANCE_TOKEN_TRANSFER_THRESHOLD,
  DEFAULT_BLOCK_RANGE_FOR_CHAIN,
} from "../constants";
import { amountToDeposit, depositRelayerFeePct, l1TokenTransferThreshold, zeroAddress } from "../constants";
import { MAX_L1_TOKENS_PER_POOL_REBALANCE_LEAF, MAX_REFUNDS_PER_RELAYER_REFUND_LEAF } from "../constants";
import { HubPoolClient, AcrossConfigStoreClient, GLOBAL_CONFIG_STORE_KEYS } from "../../src/clients";
import { SpokePoolClient } from "../../src/clients";
import { deposit, Contract, SignerWithAddress, fillRelay, BigNumber } from "./index";
import { Deposit, Fill, RunningBalances } from "../../src/interfaces";
import { buildRelayerRefundTree, toBN, toBNWei, utf8ToHex } from "../../src/utils";

import winston from "winston";
import sinon from "sinon";
import chai from "chai";
export { winston, sinon };

const assert = chai.assert;
export { chai, assert };

export function assertPromiseError(promise: Promise<unknown>, errMessage?: string): Promise<void> {
  return promise
    .then(() => assert.isTrue(false))
    .catch((err) => assert.isTrue(errMessage ? err.message.includes(errMessage) : true));
}

export async function setupTokensForWallet(
  contractToApprove: utils.Contract,
  wallet: utils.SignerWithAddress,
  tokens: utils.Contract[],
  weth?: utils.Contract,
  seedMultiplier = 1
) {
  await utils.seedWallet(wallet, tokens, weth, utils.amountToSeedWallets.mul(seedMultiplier));
  await Promise.all(
    tokens.map((token) =>
      token.connect(wallet).approve(contractToApprove.address, utils.amountToDeposit.mul(seedMultiplier))
    )
  );
  if (weth) await weth.connect(wallet).approve(contractToApprove.address, utils.amountToDeposit);
}

export function createSpyLogger() {
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

const iterativelyReplaceBigNumbers = (obj: any) => {
  Object.keys(obj).forEach((key) => {
    if (BigNumber.isBigNumber(obj[key])) obj[key] = obj[key].toString();
    else if (typeof obj[key] === "object" && obj[key] !== null) iterativelyReplaceBigNumbers(obj[key]);
  });
};

export async function deploySpokePoolWithToken(fromChainId = 0, toChainId = 0, enableRoute = true) {
  const { timer, weth, erc20, spokePool, unwhitelistedErc20, destErc20 } = await utils.deploySpokePool(utils.ethers);

  await spokePool.setChainId(fromChainId == 0 ? utils.originChainId : fromChainId);

  if (enableRoute)
    await utils.enableRoutes(spokePool, [
      { originToken: erc20.address, destinationChainId: toChainId == 0 ? utils.destinationChainId : toChainId },
      { originToken: weth.address, destinationChainId: toChainId == 0 ? utils.destinationChainId : toChainId },
    ]);
  return { timer, weth, erc20, spokePool, unwhitelistedErc20, destErc20 };
}

export async function deployConfigStore(
  signer: utils.SignerWithAddress,
  tokensToAdd: utils.Contract[],
  maxL1TokensPerPoolRebalanceLeaf: number = MAX_L1_TOKENS_PER_POOL_REBALANCE_LEAF,
  maxRefundPerRelayerRefundLeaf: number = MAX_REFUNDS_PER_RELAYER_REFUND_LEAF,
  rateModel: unknown = sampleRateModel,
  transferThreshold: BigNumber = DEFAULT_POOL_BALANCE_TOKEN_TRANSFER_THRESHOLD
) {
  const configStore = await (await utils.getContractFactory("AcrossConfigStore", signer)).deploy();
  for (const token of tokensToAdd)
    await configStore.updateTokenConfig(
      token.address,
      JSON.stringify({
        rateModel: rateModel,
        transferThreshold: transferThreshold.toString(),
      })
    );
  await configStore.updateGlobalConfig(
    utf8ToHex(GLOBAL_CONFIG_STORE_KEYS.MAX_POOL_REBALANCE_LEAF_SIZE),
    maxL1TokensPerPoolRebalanceLeaf.toString()
  );
  await configStore.updateGlobalConfig(
    utf8ToHex(GLOBAL_CONFIG_STORE_KEYS.MAX_RELAYER_REPAYMENT_LEAF_SIZE),
    maxRefundPerRelayerRefundLeaf.toString()
  );

  return { configStore };
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

  const mockAdapter = await (await utils.getContractFactory("Ethereum_Adapter", signer)).deploy();

  for (const spokePool of spokePools) {
    await hubPool.setCrossChainContracts(spokePool.l2ChainId, mockAdapter.address, spokePool.spokePool.address);
  }

  const l1Token_1 = await (await utils.getContractFactory("ExpandedERC20", signer)).deploy("Rando L1", "L1", 18);
  await l1Token_1.addMember(TokenRolesEnum.MINTER, signer.address);
  const l1Token_2 = await (await utils.getContractFactory("ExpandedERC20", signer)).deploy("Rando L1", "L1", 18);
  await l1Token_2.addMember(TokenRolesEnum.MINTER, signer.address);

  return { hubPool, mockAdapter, l1Token_1, l1Token_2 };
}

export async function deployNewToken(owner) {
  const l2Token = await (await utils.getContractFactory("ExpandedERC20", owner)).deploy("L2 Token", "L2", 18);
  await l2Token.addMember(TokenRolesEnum.MINTER, l2Token.address);
  return l2Token;
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
    JSON.stringify({ rateModel: sampleRateModel, transferThreshold: l1TokenTransferThreshold })
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
  return { ...depositObject, realizedLpFeePct: utils.toBN(0), destinationToken: zeroAddress };
}

export async function deploySpokePoolForIterativeTest(
  logger,
  signer: utils.SignerWithAddress,
  mockAdapter: utils.Contract,
  configStoreClient: AcrossConfigStoreClient,
  desiredChainId = 0
) {
  const { spokePool } = await deploySpokePoolWithToken(desiredChainId, 0, false);

  await configStoreClient.hubPoolClient.hubPool.setCrossChainContracts(
    utils.destinationChainId,
    mockAdapter.address,
    spokePool.address
  );
  const spokePoolClient = new SpokePoolClient(logger, spokePool.connect(signer), configStoreClient, desiredChainId);

  return { spokePool, spokePoolClient };
}

// Deploy, enable route and set pool rebalance route a new token over all spoke pools.
export async function deploySingleTokenAcrossSetOfChains(
  signer: utils.SignerWithAddress,
  spokePools: { contract: utils.Contract; chainId: number }[],

  hubPool: utils.Contract,
  associatedL1Token: utils.Contract
) {
  // Deploy one token per spoke pool. This of this as deploying USDC on all chains.
  const tokens = [];
  for (let i = 0; i < spokePools.length; i++) {
    const erc20 = await (await utils.getContractFactory("ExpandedERC20", signer)).deploy("Yeet Coin", "Coin", 18);
    await erc20.addMember(TokenRolesEnum.MINTER, signer.address);
    tokens.push(erc20);
  }

  // For each spokePool, whitelist the associated token above as an 'origin' token to all other destination chains. Also,
  // enable the pool rebalance route for the l1Token and newly deployed token.
  for (const [index, spokePool] of spokePools.entries()) {
    for (const otherSpokePool of spokePools) {
      if (spokePool === otherSpokePool) continue;
      await utils.enableRoutes(spokePool.contract, [
        { originToken: tokens[index].address, destinationChainId: await otherSpokePool.chainId },
      ]);
    }

    await hubPool.setPoolRebalanceRoute(spokePool.chainId, associatedL1Token.address, tokens[index].address);
  }
  return tokens;
}

export function appendPropsToDeposit(deposit) {
  return { ...deposit, realizedLpFeePct: utils.toBN(0), destinationToken: zeroAddress };
}

export async function getLastBlockTime(provider: any) {
  return (await provider.getBlock(await provider.getBlockNumber())).timestamp;
}

export async function deployIterativeSpokePoolsAndToken(
  logger: winston.Logger,
  signer: utils.SignerWithAddress,
  mockAdapter: utils.Contract,
  configStoreClient: AcrossConfigStoreClient,
  numSpokePools: number,
  numTokens: number
) {
  const spokePools = [];
  const l1TokenToL2Tokens = {};

  // For each count of numSpokePools deploy a new spoke pool. Set the chainId to the index in the array. Note that we
  // start at index of 1 here. spokePool with a chainId of 0 is not a good idea.
  for (let i = 1; i < numSpokePools + 1; i++)
    spokePools.push(await deploySpokePoolForIterativeTest(logger, signer, mockAdapter, configStoreClient, i));

  // For each count of numTokens deploy a new token. This will also set it as an enabled route over all chains.
  for (let i = 1; i < numTokens + 1; i++) {
    // Create an in incrementing address from 0x0000000000000000000000000000000000000001.
    const associatedL1Token = await (
      await utils.getContractFactory("ExpandedERC20", signer)
    ).deploy("Yeet Coin L1", "Coin", 18);
    await associatedL1Token.addMember(TokenRolesEnum.MINTER, signer.address);
    if (!l1TokenToL2Tokens[associatedL1Token.address]) l1TokenToL2Tokens[associatedL1Token.address] = [];
    l1TokenToL2Tokens[associatedL1Token.address] = await deploySingleTokenAcrossSetOfChains(
      signer,
      spokePools.map((spokePool, index) => ({ contract: spokePool.spokePool, chainId: index + 1 })),
      configStoreClient.hubPoolClient.hubPool,
      associatedL1Token
    );
  }
  return { spokePools, l1TokenToL2Tokens };
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

export async function contractAt(contractName: string, signer: utils.Signer, address: string) {
  try {
    const artifactInterface = (await utils.getContractFactory(contractName, signer)).interface;
    return new utils.Contract(address, artifactInterface, signer);
  } catch (error) {
    throw new Error(`Could not find the artifact for ${contractName}! \n${error}`);
  }
}

// Submits a deposit transaction and returns the Deposit struct that that clients interact with.
export async function buildDepositStruct(
  deposit: Deposit,
  hubPoolClient: HubPoolClient,
  configStoreClient: AcrossConfigStoreClient,
  l1TokenForDepositedToken: Contract
) {
  return {
    ...deposit,
    destinationToken: hubPoolClient.getDestinationTokenForDeposit(deposit),
    realizedLpFeePct: (await configStoreClient.computeRealizedLpFeePct(deposit, l1TokenForDepositedToken.address))
      .realizedLpFeePct,
  };
}
export async function buildDeposit(
  configStoreClient: AcrossConfigStoreClient,
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
  return await buildDepositStruct(_deposit, hubPoolClient, configStoreClient, l1TokenForDepositedToken);
}

// Submits a fillRelay transaction and returns the Fill struct that that clients will interact with.
export async function buildFill(
  spokePool: Contract,
  destinationToken: Contract,
  recipientAndDepositor: SignerWithAddress,
  relayer: SignerWithAddress,
  deposit: Deposit,
  pctOfDepositToFill: number
): Promise<Fill> {
  return await fillRelay(
    spokePool,
    destinationToken,
    recipientAndDepositor,
    recipientAndDepositor,
    relayer,
    deposit.depositId,
    deposit.originChainId,
    deposit.amount,
    deposit.amount
      .mul(toBNWei(1).sub(deposit.realizedLpFeePct.add(deposit.relayerFeePct)))
      .mul(toBNWei(pctOfDepositToFill))
      .div(toBNWei(1))
      .div(toBNWei(1)),
    deposit.realizedLpFeePct,
    deposit.relayerFeePct
  );
}

export async function buildModifiedFill(
  spokePool: Contract,
  depositor: SignerWithAddress,
  relayer: SignerWithAddress,
  fillToBuildFrom: Fill,
  multipleOfOriginalRelayerFeePct: number,
  pctOfDepositToFill: number
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
  };
  const { signature } = await utils.modifyRelayHelper(
    fillToBuildFrom.relayerFeePct.mul(multipleOfOriginalRelayerFeePct),
    fillToBuildFrom.depositId.toString(),
    fillToBuildFrom.originChainId.toString(),
    depositor
  );
  const updatedRelayerFeePct = fillToBuildFrom.relayerFeePct.mul(multipleOfOriginalRelayerFeePct);
  await spokePool.connect(relayer).fillRelayWithUpdatedFee(
    ...utils.getFillRelayUpdatedFeeParams(
      relayDataFromFill,
      fillToBuildFrom.amount
        .mul(toBNWei(1).sub(fillToBuildFrom.realizedLpFeePct.add(updatedRelayerFeePct)))
        .mul(toBNWei(pctOfDepositToFill))
        .div(toBNWei(1))
        .div(toBNWei(1)),
      updatedRelayerFeePct,
      signature
    )
  );
  const [events, destinationChainId] = await Promise.all([
    spokePool.queryFilter(spokePool.filters.FilledRelay()),
    spokePool.chainId(),
  ]);
  const lastEvent = events[events.length - 1];
  if (lastEvent.args)
    return {
      amount: lastEvent.args.amount,
      totalFilledAmount: lastEvent.args.totalFilledAmount,
      fillAmount: lastEvent.args.fillAmount,
      repaymentChainId: Number(lastEvent.args.repaymentChainId),
      originChainId: Number(lastEvent.args.originChainId),
      relayerFeePct: lastEvent.args.relayerFeePct,
      appliedRelayerFeePct: lastEvent.args.appliedRelayerFeePct,
      realizedLpFeePct: lastEvent.args.realizedLpFeePct,
      depositId: lastEvent.args.depositId,
      destinationToken: lastEvent.args.destinationToken,
      relayer: lastEvent.args.relayer,
      depositor: lastEvent.args.depositor,
      recipient: lastEvent.args.recipient,
      isSlowRelay: lastEvent.args.isSlowRelay,
      destinationChainId: Number(destinationChainId),
    };
  else return null;
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
  if (lastEvent.args)
    return {
      amount: lastEvent.args.amount,
      totalFilledAmount: lastEvent.args.totalFilledAmount,
      fillAmount: lastEvent.args.fillAmount,
      repaymentChainId: Number(lastEvent.args.repaymentChainId),
      originChainId: Number(lastEvent.args.originChainId),
      relayerFeePct: lastEvent.args.relayerFeePct,
      appliedRelayerFeePct: lastEvent.args.appliedRelayerFeePct,
      realizedLpFeePct: lastEvent.args.realizedLpFeePct,
      depositId: lastEvent.args.depositId,
      destinationToken: lastEvent.args.destinationToken,
      relayer: lastEvent.args.relayer,
      depositor: lastEvent.args.depositor,
      recipient: lastEvent.args.recipient,
      isSlowRelay: lastEvent.args.isSlowRelay,
      destinationChainId: Number(destinationChainId),
    };
  else return null;
}

// Returns expected leaves ordered by origin chain ID and then deposit ID(ascending). Ordering is implemented
// same way that dataworker orders them.
export function buildSlowRelayLeaves(deposits: Deposit[]) {
  return deposits
    .map((_deposit) => {
      return {
        depositor: _deposit.depositor,
        recipient: _deposit.recipient,
        destinationToken: _deposit.destinationToken,
        amount: _deposit.amount,
        originChainId: _deposit.originChainId.toString(),
        destinationChainId: _deposit.destinationChainId.toString(),
        realizedLpFeePct: _deposit.realizedLpFeePct,
        relayerFeePct: _deposit.relayerFeePct,
        depositId: _deposit.depositId.toString(),
      };
    }) // leaves should be ordered by origin chain ID and then deposit ID (ascending).
    .sort((relayA, relayB) => {
      if (relayA.originChainId !== relayB.originChainId)
        return Number(relayA.originChainId) - Number(relayB.originChainId);
      else return Number(relayA.depositId) - Number(relayB.depositId);
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
    Object.values(runningBalances).map((_) => Object.values(_).map((_) => toBNWei(-100))), // netSendAmounts.
    Object.values(runningBalances).map((_) => Object.values(_).map((_) => toBNWei(100))), // runningBalances.
    Object.keys(runningBalances).map((_) => 0) // group index
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
      proof
    );
  return {
    ...lastFillForDeposit,
    totalFilledAmount: lastFillForDeposit.amount, // Slow relay always fully fills deposit
    fillAmount: lastFillForDeposit.amount.sub(lastFillForDeposit.totalFilledAmount), // Fills remaining after latest fill for deposit
    repaymentChainId: 0, // Always set to 0 for slow fills
    appliedRelayerFeePct: toBN(0), // Always set to 0 since there was no relayer
    isSlowRelay: true,
    relayer: relayer.address, // Set to caller of `executeSlowRelayLeaf`
  };
}

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
