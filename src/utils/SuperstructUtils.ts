import { BigNumber } from "ethers";
import { object, number, optional, string, array, record, coerce, enums } from "superstruct";
import { FillType } from "../interfaces";

const BigNumberType = coerce(object(), string(), (value) => {
  try {
    // Attempt to convert the string to a BigNumber
    return BigNumber.from(value);
  } catch (error) {
    // In case of any error during conversion, return the original value
    // This will lead to a validation error, as the resulting value won't match the expected BigNumber type
    return value;
  }
});

function toEnumValue<T>(value: number, enumType: T): T {
  const enumKeys = Object.keys(enumType).filter((k) => !isNaN(Number(k)));
  const key = enumKeys.find((key) => key === String(value));
  return key !== undefined ? enumType[key] : undefined;
}

const FillTypeSS = coerce(enums(Object.values(FillType).map(String)), number(), (value) => {
  const enumValue = toEnumValue(value, FillType);
  if (enumValue !== undefined) {
    return enumValue;
  }
  throw new Error(`Invalid FillType value: ${value}`);
});

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

const nestedV3DepositRecordSS = record(
  coerce(string(), number(), Number),
  record(string(), array(V3DepositWithBlockSS))
);
const nestedV3BundleFillsSS = record(
  // Coerce string key to number
  coerce(string(), number(), Number),
  record(
    string(),
    object({
      fills: array(BundleFillV3SS),
      refunds: record(string(), BigNumberType),
      totalRefundAmount: BigNumberType,
      realizedLpFees: BigNumberType,
    })
  )
);

export const BundleDataToPersistToDALayerTypeSS = object({
  bundleBlockRanges: array(array(number())),
  bundleDepositsV3: nestedV3DepositRecordSS,
  expiredDepositsToRefundV3: nestedV3DepositRecordSS,
  unexecutableSlowFills: nestedV3DepositRecordSS,
  bundleSlowFillsV3: nestedV3DepositRecordSS,
  bundleFillsV3: nestedV3BundleFillsSS,
});
