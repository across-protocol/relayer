import { object, number, optional, string, array, record, coerce, instance, pattern } from "superstruct";
import { BigNumber } from "ethers";

const PositiveIntegerStringSS = pattern(string(), /\d+/);
const Web3AddressSS = pattern(string(), /^0x[a-fA-F0-9]{40}$/);

const BigNumberType = coerce(instance(BigNumber), string(), (value) => {
  try {
    // Attempt to convert the string to a BigNumber
    return BigNumber.from(value);
  } catch (error) {
    // In case of any error during conversion, return the original value
    // This will lead to a validation error, as the resulting value won't match the expected BigNumber type
    return value;
  }
});

const FillTypeSS = number();
const RelayDataCommonSS = {
  originChainId: number(),
  depositor: string(),
  recipient: string(),
  depositId: number(),
  message: string(),
};

const V3RelayDataSS = {
  ...RelayDataCommonSS,
  inputToken: string(),
  inputAmount: BigNumberType,
  outputToken: string(),
  outputAmount: BigNumberType,
  fillDeadline: number(),
  exclusiveRelayer: string(),
  exclusivityDeadline: number(),
};

const SortableEventSS = {
  blockNumber: number(),
  transactionIndex: number(),
  logIndex: number(),
  transactionHash: string(),
};

const V3DepositSS = {
  destinationChainId: number(),
  quoteTimestamp: number(),
  realizedLpFeePct: optional(BigNumberType),
  relayerFeePct: optional(BigNumberType),
  speedUpSignature: optional(string()),
  updatedRecipient: optional(string()),
  updatedOutputAmount: optional(BigNumberType),
  updatedMessage: optional(string()),
};

const V3DepositWithBlockSS = object({
  quoteBlockNumber: number(),
  ...V3DepositSS,
  ...SortableEventSS,
  ...V3RelayDataSS,
});

const V3RelayExecutionEventInfoSS = object({
  updatedOutputAmount: BigNumberType,
  fillType: FillTypeSS,
  updatedRecipient: string(),
  updatedMessage: string(),
});

const V3FillSS = {
  ...V3RelayDataSS,
  destinationChainId: number(),
  relayer: string(),
  repaymentChainId: number(),
  relayExecutionInfo: V3RelayExecutionEventInfoSS,
  quoteTimestamp: number(),
};

const V3FillWithBlockSS = {
  ...SortableEventSS,
  ...V3FillSS,
};

const BundleFillV3SS = object({
  ...V3FillWithBlockSS,
  lpFeePct: BigNumberType,
});

const nestedV3DepositRecordSS = record(PositiveIntegerStringSS, record(Web3AddressSS, array(V3DepositWithBlockSS)));
const nestedV3BundleFillsSS = record(
  // Must be a chainId
  PositiveIntegerStringSS,
  record(
    Web3AddressSS,
    object({
      fills: array(BundleFillV3SS),
      refunds: record(string(), BigNumberType),
      totalRefundAmount: BigNumberType,
      realizedLpFees: BigNumberType,
    })
  )
);

export const BundleDataSS = object({
  bundleBlockRanges: array(array(number())),
  bundleDepositsV3: nestedV3DepositRecordSS,
  expiredDepositsToRefundV3: nestedV3DepositRecordSS,
  unexecutableSlowFills: nestedV3DepositRecordSS,
  bundleSlowFillsV3: nestedV3DepositRecordSS,
  bundleFillsV3: nestedV3BundleFillsSS,
});
