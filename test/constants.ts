import { randomAddress, toWei, originChainId, destinationChainId, repaymentChainId } from "./utils";
export const randomL1Token = randomAddress();
export const randomOriginToken = randomAddress();
export const randomDestinationToken = randomAddress();
export const randomDestinationToken2 = randomAddress();

// Max number of refunds in relayer refund leaf for a { repaymentChainId, L2TokenAddress }.
export const MAX_REFUNDS_PER_RELAYER_REFUND_LEAF = 3;

// Max number of L1 tokens for a chain ID in a pool rebalance leaf.
export const MAX_L1_TOKENS_PER_POOL_REBALANCE_LEAF = 3;

// DAI's Rate model.
export const sampleRateModel = {
  UBar: toWei(0.8).toString(),
  R0: toWei(0.04).toString(),
  R1: toWei(0.07).toString(),
  R2: toWei(0.75).toString(),
};

export const CHAIN_ID_TEST_LIST = [originChainId, destinationChainId, repaymentChainId];

export const baseSpeedUpString = "ACROSS-V2-FEE-1.0";

export * from "@across-protocol/contracts-v2/dist/test-utils"; // Contains all the Across contract constants.
