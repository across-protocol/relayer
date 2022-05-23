import { BigNumber, winston, toWei, toBN, assign } from "../../utils";
import { SpokePoolClient, HubPoolClient } from "../";
import { OptimismAdapter } from "./";
import * as ArbitrumAdapter from "./ArbitrumAdapter";
import * as PolygonAdapter from "./PolygonAdapter";

export class AdapterManager {
  private optimismAdapter: OptimismAdapter;
  private bobaAdapter: OptimismAdapter;

  constructor(
    readonly logger: winston.Logger,
    readonly spokePoolClients: { [chainId: number]: SpokePoolClient },
    readonly hubPoolClient: HubPoolClient,
    readonly relayerAddress: string
  ) {
    this.optimismAdapter = new OptimismAdapter(logger, spokePoolClients, relayerAddress, true);
    this.bobaAdapter = new OptimismAdapter(logger, spokePoolClients, relayerAddress, false);
  }

  async getOutstandingCrossChainTokenTransferAmount(
    chainId: number,
    l1Tokens: string[]
  ): Promise<{ [l1Token: string]: BigNumber }> {
    this.logger.debug({ at: "AdapterManager", message: "Getting outstandingCrossChainTransfers", chainId, l1Tokens });

    // Note the call below is SEQUENTIAL AND BLOCKING. This is by design. if you fire off multiple calls to the same
    // chain looking for each cross-chain transfer for a given token the providers start getting unhappy and throwing
    // timeout errors. This is not simple to paginate within the EventUtils as there are multiple inbound calls to
    // the even processing logic all happening at a similar time. Not that inbound calls to this method CAN happen
    // in parallel as these queries are going to separate chains and so there is no node overloading.
    switch (chainId) {
      case 10:
        return await this.optimismAdapter.getOutstandingCrossChainTransfers(l1Tokens);
        break;
      case 137:
        // outstandingTransfers = await this.getOutstandingPolygonTransfers(l1Tokens);
        break;
      case 288:
        return await this.bobaAdapter.getOutstandingCrossChainTransfers(l1Tokens);
        break;
      case 42161:
        // outstandingTransfers = await this.getOutstandingArbitrumTransfers(l1Tokens);
        break;
      default:
        break;
    }
  }

  async sendTokenCrossChain(chainId: number, l1Token: string, amount: BigNumber) {
    this.logger.debug({ at: "AdapterManager", message: "Getting outstandingCrossChainTransfers", chainId, l1Token });
    let tx;
    switch (chainId) {
      case 10:
        tx = await this.sendTokensToOptimism(l1Token, amount);
        break;

      default:
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

  getL2TokenForL1Token(l1Token: string, chainId: number): string {
    console.log("getL1TokensToDestinationTokens", this.hubPoolClient.getL1TokensToDestinationTokens());
    return this.hubPoolClient.getDestinationTokenForL1Token(l1Token, chainId);
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
    return await Promise.all(
      l1Tokens.map((l1Token) =>
        PolygonAdapter.getOutstandingCrossChainTransfers(
          this.getProvider(l1ChainId),
          this.getProvider(l2ChainId),
          this.relayerAddress,
          l1Token,
          this.spokePoolClients[l1ChainId].searchConfig,
          this.spokePoolClients[l2ChainId].searchConfig
        )
      )
    );
  }

  async getOutstandingArbitrumTransfers(l1Tokens: string[], l1ChainId = 1, l2ChainId = 42161): Promise<BigNumber[]> {
    return await Promise.all(
      l1Tokens.map((l1Token) =>
        ArbitrumAdapter.getOutstandingCrossChainTransfers(
          this.getProvider(l1ChainId),
          this.getProvider(l2ChainId),
          this.relayerAddress,
          l1Token,
          this.spokePoolClients[l1ChainId].searchConfig,
          this.spokePoolClients[l2ChainId].searchConfig
        )
      )
    );
  }

  async sendTokensToOptimism(l1Token: string, amount: BigNumber) {
    return await this.optimismAdapter.sendTokenToTargetChain(l1Token, this.getL2TokenForL1Token(l1Token, 10), amount);
  }

  async update() {}
}
