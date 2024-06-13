import { winston, CHAIN_IDs } from "../../../../utils";
import { SpokePoolClient } from "../../..";
import { OpStackAdapter } from "../OpStackAdapter";
import { SUPPORTED_TOKENS } from "../../../../common";

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
      SUPPORTED_TOKENS[CHAIN_IDs.BASE], 
      spokePoolClients,
      monitoredAddresses
    );
  }
}
