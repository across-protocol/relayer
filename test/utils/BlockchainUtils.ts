import hre from "hardhat";

/**
 * Mines a random number of blocks.
 * @param amount Amount of blocks to mine. If not provided, a random number of blocks will be mined.
 */
export async function mineRandomBlocks(amount?: number): Promise<void> {
  const randomBlocksToMine = amount ?? Math.ceil(Math.random() * 10);
  for (let i = 0; i < randomBlocksToMine; i++) {
    await hre.network.provider.send("evm_mine");
  }
}
