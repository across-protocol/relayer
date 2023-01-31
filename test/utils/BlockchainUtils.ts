import { hre } from ".";

export async function mineRandomBlocks(): Promise<void> {
  const randomBlocksToMine = Math.ceil(Math.random() * 10);
  for (let i = 0; i < randomBlocksToMine; i++) {
    await hre.network.provider.send("evm_mine");
  }
}
