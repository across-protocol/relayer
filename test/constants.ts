import {
  amountToDeposit,
  amountToLp,
  amountToRelay,
  depositRelayerFeePct,
  originChainId,
  destinationChainId,
  mockTreeRoot,
  repaymentChainId,
  refundProposalLiveness,
  randomAddress,
} from "@across-protocol/contracts/dist/test-utils";
import { bnOne, bnUint256Max, toWei, ZERO_ADDRESS } from "../src/utils";

export {
  amountToDeposit,
  amountToLp,
  amountToRelay,
  depositRelayerFeePct,
  originChainId,
  destinationChainId,
  mockTreeRoot,
  repaymentChainId,
  refundProposalLiveness,
  ZERO_ADDRESS,
};
export { CONFIG_STORE_VERSION } from "../src/common";

export const randomL1Token = randomAddress();
export const randomOriginToken = randomAddress();
export const randomDestinationToken = randomAddress();
export const randomDestinationToken2 = randomAddress();

// This lookback of 24 hours should be enough to cover all Deposit events in the test cases.
export const DEFAULT_UNFILLED_DEPOSIT_LOOKBACK = 1 * 24 * 60 * 60;

// Max number of refunds in relayer refund leaf for a { repaymentChainId, L2TokenAddress }.
export const MAX_REFUNDS_PER_RELAYER_REFUND_LEAF = 3;

// Max number of L1 tokens for a chain ID in a pool rebalance leaf.
export const MAX_L1_TOKENS_PER_POOL_REBALANCE_LEAF = 3;

export const BUNDLE_END_BLOCK_BUFFER = 5;

// DAI's Rate model.
export const sampleRateModel = {
  UBar: toWei(0.8).toString(),
  R0: toWei(0.04).toString(),
  R1: toWei(0.07).toString(),
  R2: toWei(0.75).toString(),
};

export const defaultTokenConfig = JSON.stringify({
  rateModel: sampleRateModel,
});

// Add Mainnet chain ID 1 to the chain ID list because the dataworker uses this chain to look up latest GlobalConfig
// updates for config variables like MAX_REFUND_COUNT_FOR_RELAYER_REPAYMENT_LEAF.
export const CHAIN_ID_TEST_LIST = [originChainId, destinationChainId, repaymentChainId, 1];
export const DEFAULT_BLOCK_RANGE_FOR_CHAIN = [
  // For each chain ID in above list, default range is set super high so as to contain all events in a test
  // in the straightforward test cases.
  [0, 1_000_000],
  [0, 1_000_000],
  [0, 1_000_000],
  [0, 1_000_000],
];

export const IMPOSSIBLE_BLOCK_RANGE = DEFAULT_BLOCK_RANGE_FOR_CHAIN.map((range) => [range[1], range[1]]);

export const baseSpeedUpString = "ACROSS-V2-FEE-1.0";

export const defaultMinDepositConfirmations = {
  [originChainId]: [
    { usdThreshold: bnUint256Max.sub(bnOne), minConfirmations: 0 },
    { usdThreshold: bnUint256Max, minConfirmations: Number.MAX_SAFE_INTEGER },
  ],
  [destinationChainId]: [
    { usdThreshold: bnUint256Max.sub(bnOne), minConfirmations: 0 },
    { usdThreshold: bnUint256Max, minConfirmations: Number.MAX_SAFE_INTEGER },
  ],
};
