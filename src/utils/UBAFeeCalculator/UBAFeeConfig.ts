import { BigNumber } from "ethers";
import UBAPiecewiseFunction from "./UBAPiecewiseFn";

type ChainId = number;
type Token = string;

/**
 * Defines the configuration needed to calculate the UBA fees
 */
interface UBAConfig {
  /**
   * A baseline fee that is applied to all transactions to allow LPs to earn a fee
   */
  baselineFee: BigNumber;
  /**
   * A record of piecewise functions for each chain that define the utilization fee to ensure that
   * the bridge responds to periods of high utilization
   */
  utilizationFee: Record<Token, UBAPiecewiseFunction<BigNumber>>;
  /**
   * A record of piecewise functions for each chain and token that define the balancing fee to ensure
   * either a positive or negative penalty to bridging a token to a chain that is either under or
   * over utilized
   */
  balancingFee: Record<ChainId, Record<Token, UBAPiecewiseFunction<BigNumber>>>;
}

export default UBAConfig;
