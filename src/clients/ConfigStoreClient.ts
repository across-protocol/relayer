import { winston } from "../utils";

export class ConfigStoreClient {
  public isUpdated: boolean = false;

  // eslint-disable-next-line no-useless-constructor
  constructor(
    readonly logger: winston.Logger,
    // TODO: Fetch these programatically from ConfigStore contract eventually
    readonly maxRefundsPerRelayerRefundLeaf: number = 25,
    readonly maxL1TokensPerPoolRebalanceLeaf: number = 25,
    readonly startingBlock: number = 0
  ) {}

  async update() {
    this.isUpdated = true;
    this.logger.debug({ at: "ConfigStoreClient", message: "Client updated!" });
  }
}
