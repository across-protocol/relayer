import * as utils from "@across-protocol/contracts-v2/dist/test-utils";
import { TokenRolesEnum } from "@uma/common";
export { MAX_SAFE_ALLOWANCE } from "@uma/common";
import { SpyTransport } from "@uma/financial-templates-lib";
import { sampleRateModel, toBN, zeroAddress } from "../constants";

import { SpokePoolClient } from "../../src/clients/SpokePoolClient";
import { RateModelClient } from "../../src/clients/RateModelClient";
import { HubPoolClient } from "../../src/clients/HubPoolClient";

import { deposit, Contract, SignerWithAddress, fillRelay, BigNumber } from "./index";
import { amountToDeposit, depositRelayerFeePct } from "../constants";
import { Deposit, Fill } from "../../src/interfaces/SpokePool";
import { toBNWei } from "../../src/utils";

import winston from "winston";
import sinon from "sinon";
import chai from "chai";
export { winston, sinon };

const assert = chai.assert;
export { chai, assert };

export function assertPromiseError(promise: Promise<any>, errMessage?: string) {
  promise
    .then(() => assert.isTrue(false))
    .catch((err) => assert.isTrue(errMessage ? err.message.includes(errMessage) : true));
}

export async function setupTokensForWallet(
  spokePool: utils.Contract,
  wallet: utils.SignerWithAddress,
  tokens: utils.Contract[],
  weth: utils.Contract,
  seedMultiplier: number = 1
) {
  await utils.seedWallet(wallet, tokens, weth, utils.amountToSeedWallets.mul(seedMultiplier));
  await Promise.all(
    tokens.map((token) => token.connect(wallet).approve(spokePool.address, utils.amountToDeposit.mul(seedMultiplier)))
  );
  if (weth) await weth.connect(wallet).approve(spokePool.address, utils.amountToDeposit);
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

// TODO: remove this when we've accessed it from UMA protocol FPL: https://github.com/UMAprotocol/protocol/pull/3878
export function bigNumberFormatter(logEntry: any) {
  try {
    iterativelyReplaceBigNumbers(logEntry);
  } catch (_) {
    return logEntry;
  }
  return logEntry;
}

const iterativelyReplaceBigNumbers = (obj: any) => {
  Object.keys(obj).forEach((key) => {
    if (BigNumber.isBigNumber(obj[key])) obj[key] = obj[key].toString();
    else if (typeof obj[key] === "object" && obj[key] !== null) iterativelyReplaceBigNumbers(obj[key]);
  });
};

export async function deploySpokePoolWithToken(
  fromChainId: number = 0,
  toChainId: number = 0,
  enableRoute: boolean = true
) {
  const { timer, weth, erc20, spokePool, unwhitelistedErc20, destErc20 } = await utils.deploySpokePool(utils.ethers);

  await spokePool.setChainId(fromChainId == 0 ? utils.originChainId : fromChainId);

  if (enableRoute)
    await utils.enableRoutes(spokePool, [
      { originToken: erc20.address, destinationChainId: toChainId == 0 ? utils.destinationChainId : toChainId },
      { originToken: weth.address, destinationChainId: toChainId == 0 ? utils.destinationChainId : toChainId },
    ]);
  return { timer, weth, erc20, spokePool, unwhitelistedErc20, destErc20 };
}

export async function deployRateModelStore(signer: utils.SignerWithAddress, tokensToAdd: utils.Contract[]) {
  const rateModelStore = await (await utils.getContractFactory("RateModelStore", signer)).deploy();
  for (const token of tokensToAdd) await rateModelStore.updateRateModel(token.address, JSON.stringify(sampleRateModel));
  return { rateModelStore };
}

export async function deployAndConfigureHubPool(
  signer: utils.SignerWithAddress,
  spokePools: { l2ChainId: number; spokePool: utils.Contract }[]
) {
  const lpTokenFactory = await (await utils.getContractFactory("LpTokenFactory", signer)).deploy();
  const hubPool = await (
    await utils.getContractFactory("HubPool", signer)
  ).deploy(lpTokenFactory.address, zeroAddress, zeroAddress, zeroAddress);

  const mockAdapter = await (await utils.getContractFactory("Mock_Adapter", signer)).deploy();

  for (const spokePool of spokePools) {
    await hubPool.setCrossChainContracts(spokePool.l2ChainId, mockAdapter.address, spokePool.spokePool.address);
  }

  const l1Token = await (await utils.getContractFactory("ExpandedERC20", signer)).deploy("Rando L1", "L1", 18);
  await l1Token.addMember(TokenRolesEnum.MINTER, signer.address);

  return { hubPool, mockAdapter, l1Token };
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
  rateModelClient: RateModelClient,
  desiredChainId: number = 0
) {
  const { spokePool } = await deploySpokePoolWithToken(desiredChainId, 0, false);

  await rateModelClient.hubPoolClient.hubPool.setCrossChainContracts(
    utils.destinationChainId,
    mockAdapter.address,
    spokePool.address
  );
  const spokePoolClient = new SpokePoolClient(logger, spokePool.connect(signer), rateModelClient, desiredChainId);

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
  let tokens = [];
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
  rateModelClient: RateModelClient,
  numSpokePools: number,
  numTokens: number
) {
  let spokePools = [];
  let l1TokenToL2Tokens = {};

  // For each count of numSpokePools deploy a new spoke pool. Set the chainId to the index in the array. Note that we
  // start at index of 1 here. spokePool with a chainId of 0 is not a good idea.
  for (let i = 1; i < numSpokePools + 1; i++)
    spokePools.push(await deploySpokePoolForIterativeTest(logger, signer, mockAdapter, rateModelClient, i));

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
      rateModelClient.hubPoolClient.hubPool,
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
  await l1Token.approve(hubPool.address, amount);
  await hubPool.enableL1TokenForLiquidityProvision(l1Token.address);
  await hubPool.addLiquidity(l1Token.address, amount);
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
  rateModelClient: RateModelClient,
  l1TokenForDepositedToken: Contract
) {
  return {
    ...deposit,
    destinationToken: hubPoolClient.getDestinationTokenForDeposit(deposit),
    realizedLpFeePct: await rateModelClient.computeRealizedLpFeePct(deposit, l1TokenForDepositedToken.address),
  };
}
export async function buildDeposit(
  rateModelClient: RateModelClient,
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
  return await buildDepositStruct(_deposit, hubPoolClient, rateModelClient, l1TokenForDepositedToken);
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
  return {
    ...(await fillRelay(
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
    )),
    ...{ appliedRelayerFeePct: toBN(0) }, // temp work arround while the bot is limited on the older verson of the contract
  };
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
