import { winston } from "../../../../utils";
import { SpokePoolClient } from "../../..";
import { OpStackAdapter } from "../OpStackAdapter";

// Note: this is called BaseChainAdapter because BaseAdapter is the name of the base class.
export class BaseChainAdapter extends OpStackAdapter {
  constructor(
    logger: winston.Logger,
    readonly spokePoolClients: { [chainId: number]: SpokePoolClient },
    monitoredAddresses: string[]
  ) {
    super(
      8453,
      // Custom Bridges
      {},
      logger,
      ["BAL", "DAI", "ETH", "WETH", "USDC"],
      spokePoolClients,
      monitoredAddresses
    );
  }
}
