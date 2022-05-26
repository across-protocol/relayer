import { BigNumber, winston, toWei, toBN, assign } from "../../utils";
import { SpokePoolClient, HubPoolClient } from "../";
import { OptimismAdapter, ArbitrumAdapter, PolygonAdapter } from "./";
export class AdapterManager {
  private optimismAdapter: OptimismAdapter;
  private bobaAdapter: OptimismAdapter;
  private arbitrumAdapter: ArbitrumAdapter;
  private polygonAdapter: PolygonAdapter;

  constructor(
    readonly logger: winston.Logger,
    readonly spokePoolClients: { [chainId: number]: SpokePoolClient },
    readonly hubPoolClient: HubPoolClient,
    readonly relayerAddress: string
  ) {
    this.optimismAdapter = new OptimismAdapter(logger, spokePoolClients, relayerAddress, true);
    this.bobaAdapter = new OptimismAdapter(logger, spokePoolClients, relayerAddress, false);
    this.arbitrumAdapter = new ArbitrumAdapter(logger, spokePoolClients, relayerAddress);
    this.polygonAdapter = new PolygonAdapter(logger, spokePoolClients, relayerAddress);
  }

  async getOutstandingCrossChainTokenTransferAmount(
    chainId: number,
    l1Tokens: string[]
  ): Promise<{ [l1Token: string]: BigNumber }> {
    this.logger.debug({ at: "AdapterManager", message: "Getting outstandingCrossChainTransfers", chainId, l1Tokens });
    switch (chainId) {
      case 10:
        return await this.optimismAdapter.getOutstandingCrossChainTransfers(l1Tokens);
      case 137:
        return await this.polygonAdapter.getOutstandingCrossChainTransfers(l1Tokens);
      case 288:
        return await this.bobaAdapter.getOutstandingCrossChainTransfers(l1Tokens);
      case 42161:
        return await this.arbitrumAdapter.getOutstandingCrossChainTransfers(l1Tokens);
    }
  }

  async sendTokenCrossChain(chainId: number, l1Token: string, amount: BigNumber) {
    this.logger.debug({ at: "AdapterManager", message: "Getting outstandingCrossChainTransfers", chainId, l1Token });
    let tx;
    switch (chainId) {
      case 10:
        tx = await this.optimismAdapter.sendTokenToTargetChain(l1Token, this.l2TokenForL1Token(l1Token, 10), amount);
        break;
      case 137:
        tx = await this.polygonAdapter.sendTokenToTargetChain(l1Token, this.l2TokenForL1Token(l1Token, 137), amount);
        break;
      case 288:
        tx = await this.bobaAdapter.sendTokenToTargetChain(l1Token, this.l2TokenForL1Token(l1Token, 288), amount);
        break;
      case 42161:
        tx = await this.arbitrumAdapter.sendTokenToTargetChain(l1Token, this.l2TokenForL1Token(l1Token, 42161), amount);
        break;
    }
    return await tx.wait();
  }

  async wrapEthIfAboveThreshold() {
    console.log("WRAPPING");
    // const [optimismWrapTx, bobaWrapTx] = await Promise.all([
    //   OptimismAdapter.wrapEthIfAboveThreshold(this.logger, this.getSigner(10), toWei(0.1), true),
    //   OptimismAdapter.wrapEthIfAboveThreshold(this.logger, this.getSigner(288), toWei(0.05), false),
    // ]);

    // const [receipts1, receipt2] = await Promise.all([optimismWrapTx.wait(), bobaWrapTx.wait()]);
    // console.log("receipts1, receipt2", receipts1, receipt2);
  }

  getProvider(chainId: number) {
    return this.spokePoolClients[chainId].spokePool.provider;
  }

  getSigner(chainId: number) {
    return this.spokePoolClients[chainId].spokePool.signer;
  }
  getChainSearchConfig(chainId: number) {
    console.log("GETTER", this.spokePoolClients[chainId].eventSearchConfig);
    return this.spokePoolClients[chainId].eventSearchConfig;
  }

  l2TokenForL1Token(l1Token: string, chainId: number): string {
    // the try catch below is a safety hatch. If you try fetch an L2 token that is not within the hubPoolClient for a
    // given L1Token and chainId combo then you are likely trying to send a token to a chain that does not support it.
    try {
      return this.hubPoolClient.getDestinationTokenForL1Token(l1Token, chainId);
    } catch (error) {
      this.logger.error({
        at: "AdapterManager",
        message: "Implementor atempted to get an l2 token address for an L1 token that does not exist in the routings!",
        l1Token,
        chainId,
        error,
      });
      throw error;
    }
  }

  getAdapterConstructors(
    l2ChainId: number
  ): [
    l1Provider: any,
    l2Provider: any,
    l1Signer: any,
    l2Signer: any,
    initialL1SearchConfig: any,
    initialL2SearchConfig: any
  ] {
    return [
      this.getProvider(1),
      this.getProvider(l2ChainId),
      this.getSigner(1),
      this.getSigner(l2ChainId),
      this.getChainSearchConfig(1),
      this.getChainSearchConfig(l2ChainId),
    ];
  }

  async getOutstandingPolygonTransfers(l1Tokens: string[], l1ChainId = 1, l2ChainId = 137): Promise<BigNumber[]> {
    return null;
    // return await Promise.all(
    //   l1Tokens.map((l1Token) =>
    //     PolygonAdapter.getOutstandingCrossChainTransfers(
    //       this.getProvider(l1ChainId),
    //       this.getProvider(l2ChainId),
    //       this.relayerAddress,
    //       l1Token,
    //       this.spokePoolClients[l1ChainId].searchConfig,
    //       this.spokePoolClients[l2ChainId].searchConfig
    //     )
    //   )
    // );
  }

  async checkTokenApprovals(l1Tokens: string[]) {
    console.log("Checking approvals");
    await Promise.all([
      this.optimismAdapter.checkTokenApprovals(l1Tokens.filter((token) => this.l2TokenExistForL1Token(token, 10))),
      this.polygonAdapter.checkTokenApprovals(l1Tokens.filter((token) => this.l2TokenExistForL1Token(token, 137))),
      this.bobaAdapter.checkTokenApprovals(l1Tokens.filter((token) => this.l2TokenExistForL1Token(token, 288))),
      this.arbitrumAdapter.checkTokenApprovals(l1Tokens.filter((token) => this.l2TokenExistForL1Token(token, 42161))),
    ]);
  }

  l2TokenExistForL1Token(l1Token: string, l2ChainId: number): boolean {
    return this.hubPoolClient.l2TokenEnabledForL1Token(l1Token, l2ChainId);
  }

  async update() {}
}
