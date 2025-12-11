import { RebalancerAdapter } from "../rebalancer";

export class CCTPRebalancerAdapter implements RebalancerAdapter {
    // This class shouldn't require a redis client since CCTP statuses are trackable via CCTP API and/or
    // on-chain events.
}
  