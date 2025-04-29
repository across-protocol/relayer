import { CONTRACT_ADDRESSES } from "../common";

export function getSp1Helios(dstChainId: number): { address?: string; abi?: unknown[] } {
  return CONTRACT_ADDRESSES[dstChainId].sp1Helios;
}
