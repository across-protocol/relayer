import { winston } from "../utils";

export class ConfigStoreClient {
  public isUpdated: boolean = false;

  // eslint-disable-next-line no-useless-constructor
  constructor(
    readonly logger: winston.Logger,
    readonly maxRefundsPerLeaf: number = 25, // TODO: Fetch this programatically from ConfigStore contract eventually.
    readonly startingBlock: number = 0
  ) {}

  async update() {
    this.isUpdated = true;
    this.logger.debug({ at: "ConfigStoreClient", message: "Client updated!" });
  }
}
