import { BigNumber } from "ethers";

type ChainId = number;
type RouteCombination = string;

export type TupleParameter = [BigNumber, BigNumber];
type DefaultOverrideStructure<PrimaryValue, OverrideKeyType extends string | number | symbol> = {
  default: PrimaryValue;
  override?: Record<OverrideKeyType, PrimaryValue>;
};

/**
 * Defines the configuration needed to calculate the UBA fees
 */
class UBAConfig {
  /**
   * A baseline fee that is applied to all transactions to allow LPs to earn a fee
   */
  private readonly baselineFee: DefaultOverrideStructure<BigNumber, RouteCombination>;
  /**
   * A record of piecewise functions for each chain that define the utilization fee to ensure that
   * the bridge responds to periods of high utilization
   */
  private readonly utilizationFee: BigNumber;
  /**
   * A record of piecewise functions for each chain and token that define the balancing fee to ensure
   * either a positive or negative penalty to bridging a token to a chain that is either under or
   * over utilized
   */
  private readonly balancingFee: DefaultOverrideStructure<TupleParameter[], ChainId>;

  constructor(
    baselineFee: DefaultOverrideStructure<BigNumber, RouteCombination>,
    utilizationFee: BigNumber,
    balancingFee: DefaultOverrideStructure<TupleParameter[], ChainId>
  ) {
    this.baselineFee = baselineFee;
    this.utilizationFee = utilizationFee;
    this.balancingFee = balancingFee;
  }

  /**
   * @description Get the baseline fee for a given route combination
   * @param destinationChainId The destination chain id
   * @param originChainId The origin chain id
   * @returns The baseline fee
   */
  public getBaselineFee(destinationChainId: number, originChainId: number): BigNumber {
    const routeCombination = `${originChainId}-${destinationChainId}`;
    return this.baselineFee.override?.[routeCombination] ?? this.baselineFee.default;
  }

  /**
   * @description Get the utilization fee for a given chain
   * @returns The utilization fee
   */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  public getUtilizationFee(): BigNumber {
    return this.utilizationFee;
  }

  /**
   * @description Get the balancing fee tuples for a given chain
   *  @param chainId The chain id
   * @returns The balancing fee
   */
  public getBalancingFeeTuples(chainId: number): TupleParameter[] {
    return this.balancingFee.override?.[chainId] ?? this.balancingFee.default;
  }
}

export default UBAConfig;
