import * as utils from "@across-protocol/contracts-v2/dist/test-utils";
export * from "@across-protocol/contracts-v2/dist/test-utils";
import { SpyTransport } from "@uma/financial-templates-lib";

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

export async function deployAndEnableSpokePool(fromChainId: number = 0, toChainId: number = 0) {
  const { timer, weth, erc20, spokePool, unwhitelistedErc20, destErc20 } = await utils.deploySpokePool(utils.ethers);

  await spokePool.setChainId(fromChainId == 0 ? utils.originChainId : fromChainId);
  await utils.enableRoutes(spokePool, [
    { originToken: erc20.address, destinationChainId: toChainId == 0 ? utils.destinationChainId : toChainId },
    { originToken: weth.address, destinationChainId: toChainId == 0 ? utils.destinationChainId : toChainId },
  ]);
  return { timer, weth, erc20, spokePool, unwhitelistedErc20, destErc20 };
}
