import * as testUtils from "@across-protocol/contracts-v2/dist/test-utils";
export * from "@across-protocol/contracts-v2/dist/test-utils";
import { SpyTransport } from "@uma/financial-templates-lib";

import winston from "winston";
import sinon from "sinon";
export { winston, sinon };

export async function setupTokensForWallet(
  spokePool: testUtils.Contract,
  wallet: testUtils.SignerWithAddress,
  tokens: testUtils.Contract[],
  weth: testUtils.Contract,
  seedMultiplier: number = 1
) {
  await testUtils.seedWallet(wallet, tokens, weth, testUtils.amountToSeedWallets.mul(seedMultiplier));
  await Promise.all(
    tokens.map((token) =>
      token.connect(wallet).approve(spokePool.address, testUtils.amountToDeposit.mul(seedMultiplier))
    )
  );
  if (weth) await weth.connect(wallet).approve(spokePool.address, testUtils.amountToDeposit);
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
  const { timer, weth, erc20, spokePool, unwhitelistedErc20, destErc20 } = await testUtils.deploySpokePool(
    testUtils.ethers
  );

  await spokePool.setChainId(fromChainId == 0 ? testUtils.originChainId : fromChainId);
  await testUtils.enableRoutes(spokePool, [
    { originToken: erc20.address, destinationChainId: toChainId == 0 ? testUtils.destinationChainId : toChainId },
    { originToken: weth.address, destinationChainId: toChainId == 0 ? testUtils.destinationChainId : toChainId },
  ]);
  return { timer, weth, erc20, spokePool, unwhitelistedErc20, destErc20 };
}
