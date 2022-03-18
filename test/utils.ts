import * as utils from "@across-protocol/contracts-v2/dist/test-utils";
export * from "@across-protocol/contracts-v2/dist/test-utils";
export * from "@uma/financial-templates-lib";
import { TokenRolesEnum } from "@uma/common";
import { SpyTransport } from "@uma/financial-templates-lib";

import { SpokePoolEventClient } from "../src/SpokePoolEventClient";

import winston from "winston";
import sinon from "sinon";
export { winston, sinon };

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
    transports: [new SpyTransport({ level: "debug" }, { spy })],
  });

  return { spy, spyLogger };
}

export async function deploySpokePoolWithTokenAndEnable(
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

export async function deploySpokePoolForIterativeTest(
  signer: utils.SignerWithAddress,
  mockAdapter: utils.Contract,
  hubPool: utils.Contract,
  desiredChainId: number = 0
) {
  const { spokePool } = await deploySpokePoolWithTokenAndEnable(desiredChainId, 0, false);

  await hubPool.setCrossChainContracts(utils.destinationChainId, mockAdapter.address, spokePool.address);

  const spokePoolClient = new SpokePoolEventClient(spokePool.connect(signer), desiredChainId);

  return { spokePool, spokePoolClient };
}

// Deploy, enable route and set pool rebalance route a new token over all spoke pools.
export async function deploySingleTokenAcrossSetOfChains(
  signer: utils.SignerWithAddress,
  spokePools: { contract: utils.Contract; chainId: number }[],

  hubPool: utils.Contract,
  associatedL1Token: string
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

    await hubPool.setPoolRebalanceRoute(spokePool.chainId, associatedL1Token, tokens[index].address);
  }
  return tokens;
}

export async function deployIterativeSpokePoolsAndToken(
  signer,
  mockAdapter,
  hubPool,
  numSpokePools: number,
  numTokens: number
) {
  let spokePools = [];
  let l1TokenToL2Tokens = {};

  // For each count of numSpokePools deploy a new spoke pool. Set the chainId to the index in the array. Note that we
  // start at index of 1 here. spokePool with a chainId of 0 is not a good idea.
  for (let i = 1; i < numSpokePools + 1; i++) {
    spokePools.push(await deploySpokePoolForIterativeTest(signer, mockAdapter, hubPool, i));
  }

  // For each count of numTokens deploy a new token. This will also set it as an enabled route over all chains.
  for (let i = 1; i < numTokens + 1; i++) {
    // Create an in incrementing address from 0x0000000000000000000000000000000000000001.
    const associatedL1Token = utils.ethers.utils.getAddress(
      utils.ethers.utils.hexZeroPad(utils.ethers.utils.hexValue(i), 20)
    );
    if (!l1TokenToL2Tokens[associatedL1Token]) l1TokenToL2Tokens[associatedL1Token] = [];
    l1TokenToL2Tokens[associatedL1Token] = await deploySingleTokenAcrossSetOfChains(
      signer,
      spokePools.map((spokePool, index) => ({ contract: spokePool.spokePool, chainId: index + 1 })),
      hubPool,
      associatedL1Token
    );
  }
  return { spokePools, l1TokenToL2Tokens };
}
