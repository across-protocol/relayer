import { winston } from "../../../../utils";
import { SpokePoolClient } from "../../..";
import { OpStackAdapter } from "../OpStackAdapter";

export class ModeAdapter extends OpStackAdapter {
  constructor(
    logger: winston.Logger,
    readonly spokePoolClients: { [chainId: number]: SpokePoolClient },
    monitoredAddresses: string[]
  ) {
    super(
      34443,
      // Custom Bridges
      {},
      logger,
      ["ETH", "WETH", "USDC", "USDT"],
      spokePoolClients,
      monitoredAddresses
    );
  }
}
