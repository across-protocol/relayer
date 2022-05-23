import { SpokePoolClient } from "../../clients";
import { EventSearchConfig, assign } from "../../utils";
export class BaseAdapter {
  chainId: number;
  l1SearchConfig;
  l2SearchConfig;
  constructor(readonly spokePoolClients: { [chainId: number]: SpokePoolClient }) {}

  getSigner(chainId: number) {
    return this.spokePoolClients[chainId].spokePool.signer;
  }

  getProvider(chainId: number) {
    return this.spokePoolClients[chainId].spokePool.provider;
  }

  getSearchConfig(chainId: number) {
    return this.spokePoolClients[chainId].eventSearchConfig;
  }

  async updateFromBlockSearchConfig() {
    const [l1BlockNumber, l2BlockNumber] = await Promise.all([
      this.getProvider(1).getBlockNumber(),
      this.getProvider(this.chainId).getBlockNumber(),
    ]);

    this.l1SearchConfig.toBlock = l1BlockNumber;
    this.l2SearchConfig.toBlock = l2BlockNumber;
  }
}
