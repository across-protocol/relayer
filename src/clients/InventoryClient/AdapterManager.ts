import { BigNumber, winston, toWei, toBN, createFormatFunction, etherscanLink } from "../../utils";
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

  async sendTokenCrossChain(chainId: number | string, l1Token: string, amount: BigNumber) {
    this.logger.debug({ at: "AdapterManager", message: "Sending token cross-chain", chainId, l1Token, amount });
    let tx;
    switch (Number(chainId)) {
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

  async wrapEthIfAboveThreshold(wrapThreshold: BigNumber) {
    const [optimismWrapTx, bobaWrapTx] = await Promise.all([
      this.optimismAdapter.wrapEthIfAboveThreshold(wrapThreshold),
      this.bobaAdapter.wrapEthIfAboveThreshold(wrapThreshold),
    ]);

    const [optimismReceipt, bobaReceipt] = await Promise.all([
      optimismWrapTx?.wait() ?? null,
      bobaWrapTx?.wait() ?? null,
    ]);
    if (optimismReceipt || bobaReceipt) {
      let mrkdwn =
        `Ether on ${optimismReceipt ? "Optimism" : ""} ${optimismReceipt && bobaReceipt ? "and" : ""} ` +
        `${bobaReceipt ? "Boba" : ""} was wrapped due to being over the threshold of ` +
        `${createFormatFunction(2, 4, false, 18)(toBN(wrapThreshold).toString())} ETH.\n` +
        `${optimismReceipt ? `\nOptimism tx: ${etherscanLink(optimismReceipt.transactionHash, 10)} ` : ""}` +
        `${bobaReceipt ? `Boba tx: ${etherscanLink(bobaReceipt.transactionHash, 288)}` : ""}`;
      this.logger.info({ at: "AdapterManager", message: "Eth wrapped on target chain 🎁", mrkdwn });
    }
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
        message: "Implementor attempted to get a l2 token address for an L1 token that does not exist in the routings!",
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

  async setL1TokenApprovals(l1Tokens: string[]) {
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
