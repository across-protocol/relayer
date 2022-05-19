import { BigNumber, winston, toBNWei, toBN, assign } from "../../utils";
import { SpokePoolClient, HubPoolClient } from "../";
import * as OptimismAdapter from "./OptimismAdapter";
import * as ArbitrumAdapter from "./ArbitrumAdapter";
import * as PolygonAdapter from "./PolygonAdapter";

export class AdapterManager {
  constructor(
    readonly logger: winston.Logger,
    readonly spokePoolClients: { [chainId: number]: SpokePoolClient },
    readonly hubPoolClient: HubPoolClient,
    readonly relayerAddress: string
  ) {}

  async getOutstandingCrossChainTokenTransferAmount(
    chainId: number,
    l1Tokens: string[]
  ): Promise<{ [l1Token: string]: BigNumber }> {
    this.logger.debug({ at: "AdapterManager", message: "Getting outstandingCrossChainTransfers", chainId, l1Tokens });
    const outstandingCrossChainTransfers: { [l1Token: string]: BigNumber } = {};
    let outstandingTransfers = [];
    switch (chainId) {
      case 10:
        outstandingTransfers = await this.getOutstandingOptimismTransfers(l1Tokens, 1, 10);
        break;
      case 137:
        outstandingTransfers = await this.getOutstandingPolygonTransfers(l1Tokens);
        break;
      case 288:
        outstandingTransfers = await this.getOutstandingOptimismTransfers(l1Tokens, 1, 288);
        break;
      case 42161:
        outstandingTransfers = await this.getOutstandingArbitrumTransfers(l1Tokens);
        break;
      default:
        break;
    }
    l1Tokens.forEach((l1Token, index) => (outstandingCrossChainTransfers[l1Token] = outstandingTransfers[index]));

    return outstandingCrossChainTransfers;
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
    const receipt = await tx.wait();
  }

  getProviderForChainId(chainId: number) {
    return this.spokePoolClients[chainId].spokePool.provider;
  }

  getL2TokenForL1Token(l1Token: string, chainId: number) {
    this.hubPoolClient.getDestinationTokenForL1Token(l1Token, chainId);
  }

  async getOutstandingOptimismTransfers(l1Tokens: string[], l1ChainId = 1, l2ChainId = 10): Promise<BigNumber[]> {
    return await Promise.all(
      l1Tokens.map((l1Token) =>
        OptimismAdapter.getOutstandingCrossChainTransfers(
          this.getProviderForChainId(l1ChainId),
          this.getProviderForChainId(l2ChainId),
          this.relayerAddress,
          l1Token,
          this.spokePoolClients[l1ChainId].searchConfig,
          this.spokePoolClients[l2ChainId].searchConfig,
          l2ChainId == 10 // isOptimism. If not 10 then must be boba (288).
        )
      )
    );
  }

  async getOutstandingPolygonTransfers(l1Tokens: string[], l1ChainId = 1, l2ChainId = 137): Promise<BigNumber[]> {
    return await Promise.all(
      l1Tokens.map((l1Token) =>
        PolygonAdapter.getOutstandingCrossChainTransfers(
          this.getProviderForChainId(l1ChainId),
          this.getProviderForChainId(l2ChainId),
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
          this.getProviderForChainId(l1ChainId),
          this.getProviderForChainId(l2ChainId),
          this.relayerAddress,
          l1Token,
          this.spokePoolClients[l1ChainId].searchConfig,
          this.spokePoolClients[l2ChainId].searchConfig
        )
      )
    );
  }

  async sendTokensToOptimism(l1Token: string, amount: BigNumber) {
    await OptimismAdapter.sendTokenToTargetChain(
      this.logger,
      this.getProviderForChainId(1),
      l1Token,
      this.getL2TokenForL1Token(l1Token, 10),
      amount,
      true
    );
  }

  async update() {}
}
