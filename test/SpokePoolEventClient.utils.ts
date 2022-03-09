import { Contract, SignerWithAddress, seedWallet, amountToSeedWallets, amountToDeposit } from "across-contracts";

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
  await weth.connect(wallet).approve(spokePool.address, amountToDeposit);
}
