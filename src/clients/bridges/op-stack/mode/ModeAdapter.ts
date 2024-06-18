import { winston, CHAIN_IDs } from "../../../../utils";
import { SpokePoolClient } from "../../..";
import { OpStackAdapter } from "../OpStackAdapter";
import { SUPPORTED_TOKENS } from "../../../../common";

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
      SUPPORTED_TOKENS[CHAIN_IDs.MODE],
      spokePoolClients,
      monitoredAddresses
    );
  }
}
