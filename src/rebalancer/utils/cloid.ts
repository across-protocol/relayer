import { ethers } from "ethers";

export function getCloidForTimestampAndAccount(unixTimestamp: number, account: string): string {
  const cloidSeed = ethers.utils.solidityPack(["uint256", "address"], [unixTimestamp, account]);
  return ethers.utils.hexDataSlice(ethers.utils.keccak256(cloidSeed), 0, 16);
}
