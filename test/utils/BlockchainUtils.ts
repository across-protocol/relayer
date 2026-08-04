import { Contract } from "ethers";
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

/**
 * Mines a single block at the supplied timestamp. The simulated chain enforces strictly
 * increasing block timestamps, so the supplied value must be greater than the latest block's.
 */
export async function setNextBlockTimestamp(timestamp: number): Promise<void> {
  await hre.network.provider.send("evm_setNextBlockTimestamp", [timestamp]);
  await hre.network.provider.send("evm_mine", []);
}

/**
 * Advances both the simulated chain's block.timestamp and the SpokePool contract's internal
 * `_currentTime` to the supplied value. SpokePoolClient now derives currentTime from the block
 * timestamp rather than `SpokePool.getCurrentTime()`, so tests that need the client to observe
 * a particular time must move the underlying block forward — calling SpokePool.setCurrentTime
 * alone is no longer sufficient.
 */
export async function setSpokePoolTime(spokePool: Contract, timestamp: number): Promise<void> {
  await hre.network.provider.send("evm_setNextBlockTimestamp", [timestamp]);
  // The setCurrentTime transaction mines a new block, which adopts the timestamp set above.
  await spokePool.setCurrentTime(timestamp);
}
