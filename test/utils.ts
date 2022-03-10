import { amountToSeedWallets, amountToDeposit, originChainId, destinationChainId } from "@across-protocol/contracts-v2";
import { Contract, SignerWithAddress, seedWallet, deploySpokePool } from "@across-protocol/contracts-v2";
import { enableRoutes, ethers } from "@across-protocol/contracts-v2";

import winston from "winston";
import sinon from "sinon";
export { winston, sinon };

import { SpyTransport } from "@uma/financial-templates-lib";

export * from "@across-protocol/contracts-v2";

export async function setupTokensForWallet(
  spokePool: Contract,
  wallet: SignerWithAddress,
  tokens: Contract[],
  weth: Contract,
  seedMultiplier: number = 1
) {
  await seedWallet(wallet, tokens, weth, amountToSeedWallets.mul(seedMultiplier));
  await Promise.all(
    tokens.map((token) => token.connect(wallet).approve(spokePool.address, amountToDeposit.mul(seedMultiplier)))
  );
  if (weth) await weth.connect(wallet).approve(spokePool.address, amountToDeposit);
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
  const { timer, weth, erc20, spokePool, unwhitelistedErc20, destErc20 } = await deploySpokePool(ethers);

  await spokePool.setChainId(fromChainId == 0 ? originChainId : fromChainId);
  await enableRoutes(spokePool, [
    { originToken: erc20.address, destinationChainId: toChainId == 0 ? destinationChainId : toChainId },
    { originToken: weth.address, destinationChainId: toChainId == 0 ? destinationChainId : toChainId },
  ]);
  return { timer, weth, erc20, spokePool, unwhitelistedErc20, destErc20 };
}
