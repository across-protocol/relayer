import { winston, BigNumber, assert, toBN } from "../utils";

export class ConfigStoreClient {
  public isUpdated: boolean = false;
  public poolRebalanceTokenTransferThreshold: { [l1Token: string]: BigNumber };

  // eslint-disable-next-line no-useless-constructor
  constructor(
    readonly logger: winston.Logger,
    // TODO: Fetch these programatically from ConfigStore contract eventually. Specifically,
    // `poolRebalanceTokenTransferThreshold` can be downloaded to this client similar to how the rate model store
    // client works.
    _poolRebalanceTokenTransferThreshold: { [l1Token: string]: BigNumber },
    readonly maxRefundsPerRelayerRefundLeaf: number = 25,
    readonly maxL1TokensPerPoolRebalanceLeaf: number = 25,
    readonly startingBlock: number = 0
  ) {
    Object.values(_poolRebalanceTokenTransferThreshold).forEach((threshold: BigNumber) =>
      assert(threshold.gte(toBN(0)), "Threshold cannot be negative")
    );
    this.poolRebalanceTokenTransferThreshold = _poolRebalanceTokenTransferThreshold;
  }

  // Used for testing, should we block this function in prod?
  setPoolRebalanceTokenTransferThreshold(l1Token: string, newThreshold: BigNumber) {
    assert(newThreshold.gte(toBN(0)), "Threshold cannot be negative");
    this.poolRebalanceTokenTransferThreshold[l1Token] = newThreshold;
  }

  async update() {
    this.isUpdated = true;
    this.logger.debug({ at: "ConfigStoreClient", message: "Client updated!" });
  }
}
