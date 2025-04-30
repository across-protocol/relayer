import { Dataworker } from "../../src/dataworker/Dataworker";
import { DataworkerClients } from "../../src/dataworker/DataworkerClientHelper";
import { DataworkerConfig } from "../../src/dataworker/DataworkerConfig";
import { L1Token } from "../../src/interfaces";
import { winston } from "../../src/utils";

export class MockDataworker extends Dataworker {
  private tokenMap: { [chainId: number]: { [token: string]: L1Token } } = {};
  constructor(
    logger: winston.Logger,
    config: DataworkerConfig,
    clients: DataworkerClients,
    chainIdListForBundleEvaluationBlockNumbers: number[],
    maxRefundCountOverride: number | undefined,
    maxL1TokenCountOverride: number | undefined,
    spokeRootsLookbackCount = 0,
    bufferToPropose = 0,
    forceProposal = false,
    forceBundleRange?: [number, number][]
  ) {
    super(
      logger,
      config,
      clients,
      chainIdListForBundleEvaluationBlockNumbers,
      maxRefundCountOverride,
      maxL1TokenCountOverride,
      spokeRootsLookbackCount,
      bufferToPropose,
      forceProposal,
      forceBundleRange
    );
  }

  setTokenMap(chainId: number, token: string, tokenInfo: L1Token): void {
    if (!this.tokenMap[chainId]) {
      this.tokenMap[chainId] = {};
    }
    this.tokenMap[chainId][token] = tokenInfo;
  }
  override getL1TokenInfo(l2Token: string, chainId: number): L1Token {
    return this.tokenMap[chainId]?.[l2Token] ?? super.getL1TokenInfo(l2Token, chainId);
  }
}
