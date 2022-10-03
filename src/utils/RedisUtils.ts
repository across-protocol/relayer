import { SortableEvent } from "../interfaces";
import { createClient } from "redis4";

// This should be identical to interfaces/FillWithBlock except that the BigNumber types have been changed
// to strings since RedisDB stores string data.
export interface FillWithBlockInCache extends SortableEvent {
  amount: string;
  totalFilledAmount: string;
  fillAmount: string;
  repaymentChainId: number;
  originChainId: number;
  relayerFeePct: string;
  appliedRelayerFeePct: string;
  realizedLpFeePct: string;
  depositId: number;
  destinationToken: string;
  relayer: string;
  depositor: string;
  recipient: string;
  isSlowRelay: boolean;
  destinationChainId: number;
}

// This struct has the same relationship with DepositWithBlock as the above type does with FillWithBlock.
export interface DepositWithBlockInCache extends SortableEvent {
  depositId: number;
  depositor: string;
  recipient: string;
  originToken: string;
  amount: string;
  originChainId: number;
  destinationChainId: number;
  relayerFeePct: string;
  quoteTimestamp: number;
  realizedLpFeePct: string;
  destinationToken: string;
  originBlockNumber: number;
  speedUpSignature?: string;
  newRelayerFeePct?: string;
}

export interface CachedDataBlocks {
  latestBlock: number;
  earliestBlock: number;
}

export interface CachedDepositData extends CachedDataBlocks {
  deposits: { [destinationChainId: number]: DepositWithBlockInCache[] };
}

export interface CachedFillData extends CachedDataBlocks {
  fills: FillWithBlockInCache[];
}

export interface CachedData extends CachedDepositData, CachedFillData {}

export async function getFromCache(key: string, redisClient?: ReturnType<typeof createClient>): Promise<string | null> {
  if (!redisClient) return null;
  return redisClient.get(key); // Returns null if key doesn't exist in cache
}

export async function setInCache(key: string, value: string, redisClient?: ReturnType<typeof createClient>) {
  if (!redisClient) return;
  await redisClient.set(key, value);
}
