import { l2TokensToL1TokenValidation } from "../../common";
import { BigNumber, winston, toBN, createFormatFunction, etherscanLink } from "../../utils";
import { SpokePoolClient, HubPoolClient } from "../";
import { OptimismAdapter, ArbitrumAdapter, PolygonAdapter } from "./";
import { Provider } from "@ethersproject/abstract-provider";
import { Signer } from "@arbitrum/sdk/node_modules/@ethersproject/abstract-signer";
export class AdapterManager {
  public adapters: { [chainId: number]: OptimismAdapter | ArbitrumAdapter | PolygonAdapter } = {};

  constructor(
    readonly logger: winston.Logger,
    readonly spokePoolClients: { [chainId: number]: SpokePoolClient },
    readonly hubPoolClient: HubPoolClient,
    readonly relayerAddress: string
  ) {
    if (spokePoolClients) {
      this.adapters[10] = new OptimismAdapter(logger, spokePoolClients, relayerAddress, true);
      this.adapters[137] = new PolygonAdapter(logger, spokePoolClients, relayerAddress);
      this.adapters[288] = new OptimismAdapter(logger, spokePoolClients, relayerAddress, false);
      this.adapters[42161] = new ArbitrumAdapter(logger, spokePoolClients, relayerAddress);
    }
  }

  async getOutstandingCrossChainTokenTransferAmount(
    chainId: number,
    l1Tokens: string[]
  ): Promise<{ [l1Token: string]: BigNumber }> {
    this.logger.debug({ at: "AdapterManager", message: "Getting outstandingCrossChainTransfers", chainId, l1Tokens });
    return await this.adapters[chainId].getOutstandingCrossChainTransfers(l1Tokens);
  }

  async sendTokenCrossChain(chainId: number | string, l1Token: string, amount: BigNumber) {
    this.logger.debug({ at: "AdapterManager", message: "Sending token cross-chain", chainId, l1Token, amount });
    const l2Token = this.l2TokenForL1Token(l1Token, Number(chainId));
    const tx = await this.adapters[chainId].sendTokenToTargetChain(l1Token, l2Token, amount);
    return await tx.wait();
  }

  // Check how much ETH is on the target chain and if it is above the threshold the wrap it to WETH. Note that this only
  // needs to e done on Boba and Optimism as only these two chains require ETH to be sent over the canonical bridge.
  async wrapEthIfAboveThreshold(wrapThreshold: BigNumber) {
    const [optimismWrapTx, bobaWrapTx] = await Promise.all([
      (this.adapters[10] as OptimismAdapter).wrapEthIfAboveThreshold(wrapThreshold),
      (this.adapters[288] as OptimismAdapter).wrapEthIfAboveThreshold(wrapThreshold),
    ]);

    const [optimismReceipt, bobaReceipt] = await Promise.all([
      optimismWrapTx?.wait() ?? null,
      bobaWrapTx?.wait() ?? null,
    ]);
    if (optimismReceipt || bobaReceipt) {
      let mrkdwn =
        `Ether on ${optimismReceipt ? "Optimism" : ""}${optimismReceipt && bobaReceipt ? " and " : ""}` +
        `${bobaReceipt ? "Boba" : ""} was wrapped due to being over the threshold of ` +
        `${createFormatFunction(2, 4, false, 18)(toBN(wrapThreshold).toString())} ETH.\n` +
        `${optimismReceipt ? `\nOptimism tx: ${etherscanLink(optimismReceipt.transactionHash, 10)} ` : ""}` +
        `${bobaReceipt ? `Boba tx: ${etherscanLink(bobaReceipt.transactionHash, 288)}` : ""}`;
      this.logger.info({ at: "AdapterManager", message: "Eth wrapped on target chain 🎁", mrkdwn });
    }
  }

  getProvider(chainId: number): Provider {
    return this.spokePoolClients[chainId].spokePool.provider;
  }

  getSigner(chainId: number): Signer {
    return this.spokePoolClients[chainId].spokePool.signer;
  }

  getChainSearchConfig(chainId: number) {
    return this.spokePoolClients[chainId].eventSearchConfig;
  }

  l2TokenForL1Token(l1Token: string, chainId: number): string {
    // the try catch below is a safety hatch. If you try fetch an L2 token that is not within the hubPoolClient for a
    // given L1Token and chainId combo then you are likely trying to send a token to a chain that does not support it.
    try {
      // That the line below is critical. if the hubpoolClient returns the wrong destination token for the L1 token then
      // the bot can irrecoverably send the wrong token to the chain and loose money. It should crash if this is detected.
      const l2TokenForL1Token = this.hubPoolClient.getDestinationTokenForL1Token(l1Token, chainId);
      if (!l2TokenForL1Token) throw new Error("No L2 token found for L1 token");
      if (l2TokenForL1Token != l2TokensToL1TokenValidation[l1Token][chainId]) throw new Error("Mismatch tokens!");
      return l2TokenForL1Token;
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

  async setL1TokenApprovals(l1Tokens: string[]) {
    // Each of these calls must happen sequentially or we'll have collisions within the TransactionUtil. This should
    // be refactored in a follow on PR to separate out by nonce increment by making the transaction util stateful.
    await this.adapters[10].checkTokenApprovals(l1Tokens.filter((token) => this.l2TokenExistForL1Token(token, 10)));
    await this.adapters[137].checkTokenApprovals(l1Tokens.filter((token) => this.l2TokenExistForL1Token(token, 137)));
    await this.adapters[288].checkTokenApprovals(l1Tokens.filter((token) => this.l2TokenExistForL1Token(token, 288)));
    await this.adapters[42161].checkTokenApprovals(
      l1Tokens.filter((token) => this.l2TokenExistForL1Token(token, 42161))
    );
  }

  l2TokenExistForL1Token(l1Token: string, l2ChainId: number): boolean {
    return this.hubPoolClient.l2TokenEnabledForL1Token(l1Token, l2ChainId);
  }

  async update() {}
}
