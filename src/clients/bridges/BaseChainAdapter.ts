import { winston } from "../../utils";
import { SpokePoolClient } from "../../clients";
import { OpStackAdapter } from "./OpStackAdapter";

// Note: this is called BaseChainAdapter because BaseAdapter is the name of the base class.
export class BaseChainAdapter extends OpStackAdapter {
  constructor(
    logger: winston.Logger,
    readonly spokePoolClients: { [chainId: number]: SpokePoolClient },
    monitoredAddresses: string[],
    // Optional sender address where the cross chain transfers originate from. This is useful for the use case of
    // monitoring transfers from HubPool to SpokePools where the sender is HubPool.
    readonly senderAddress?: string
  ) {
    super(
      8453,
      // L1 Custom bridge addresses
      {},
      // L2 custom bridge addresses
      {},
      logger,
      spokePoolClients,
      monitoredAddresses,
      senderAddress
    );
  }
}
