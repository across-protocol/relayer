import { BigNumber, winston, toWei, toBN, createFormatFunction, etherscanLink } from "../../utils";
import { SpokePoolClient, HubPoolClient } from "../";
import { OptimismAdapter, ArbitrumAdapter, PolygonAdapter } from "./";
export class AdapterManager {
  public optimismAdapter: OptimismAdapter;
  public bobaAdapter: OptimismAdapter;
  public arbitrumAdapter: ArbitrumAdapter;
  public polygonAdapter: PolygonAdapter;

  constructor(
    readonly logger: winston.Logger,
    readonly spokePoolClients: { [chainId: number]: SpokePoolClient },
    readonly hubPoolClient: HubPoolClient,
    readonly relayerAddress: string
  ) {
    if (spokePoolClients) {
      this.optimismAdapter = new OptimismAdapter(logger, spokePoolClients, relayerAddress, true);
      this.polygonAdapter = new PolygonAdapter(logger, spokePoolClients, relayerAddress);
      this.bobaAdapter = new OptimismAdapter(logger, spokePoolClients, relayerAddress, false);
      this.arbitrumAdapter = new ArbitrumAdapter(logger, spokePoolClients, relayerAddress);
    }
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
    return this.spokePoolClients[chainId].eventSearchConfig;
  }

  l2TokenForL1Token(l1Token: string, chainId: number): string {
    // the try catch below is a safety hatch. If you try fetch an L2 token that is not within the hubPoolClient for a
    // given L1Token and chainId combo then you are likely trying to send a token to a chain that does not support it.
    try {
      // No that the line below is critical. if the hubpool returns the wrong destination token for the L1 token then
      // the bot can irrecoverably send the wrong token to the chain and loose money.
      console.log("LOOKING", l1Token, chainId);
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
    // Each of these calls must happen sequentially or we'll have collisions within the TransactionUtil. This should
    // be refactored in a follow on PR to separate out by nonce increment by making the transaction util stateful.
    await this.optimismAdapter.checkTokenApprovals(l1Tokens.filter((token) => this.l2TokenExistForL1Token(token, 10)));
    await this.polygonAdapter.checkTokenApprovals(l1Tokens.filter((token) => this.l2TokenExistForL1Token(token, 137)));
    await this.bobaAdapter.checkTokenApprovals(l1Tokens.filter((token) => this.l2TokenExistForL1Token(token, 288)));
    await this.arbitrumAdapter.checkTokenApprovals(
      l1Tokens.filter((token) => this.l2TokenExistForL1Token(token, 42161))
    );
  }

  l2TokenExistForL1Token(l1Token: string, l2ChainId: number): boolean {
    return this.hubPoolClient.l2TokenEnabledForL1Token(l1Token, l2ChainId);
  }

  async update() {}
}

// The most critical failure mode that can happen in this module is a mis-mapping between L1 token and the associated
// L2 token. If this is wrong the bot WILL delete money. The mapping below is used to enforce that what the hubpool
// thinks is the correct L2 token for a given L1 token is actually the correct L2 token. It is simply a sanity check:
// if for whatever reason this does not line up the bot show fail loudly and stop execution as something is broken
// and funds are not safe to be sent over the canonical L2 bridges.
export const l2TokensToL1TokenValidation = {
  "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48": {
    10: "0x7F5c764cBc14f9669B88837ca1490cCa17c31607",
    137: "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174",
    288: "0x66a2A913e447d6b4BF33EFbec43aAeF87890FBbc",
    42161: "0xFF970A61A04b1cA14834A43f5dE4533eBDDB5CC8",
  }, // USDC
  "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2": {
    10: "0x4200000000000000000000000000000000000006",
    137: "0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619",
    288: "0xDeadDeAddeAddEAddeadDEaDDEAdDeaDDeAD0000",
    42161: "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1",
  }, // WETH
  "0x6B175474E89094C44Da98b954EedeAC495271d0F": {
    10: "0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1",
    137: "0x8f3Cf7ad23Cd3CaDbD9735AFf958023239c6A063",
    288: "0xf74195Bb8a5cf652411867c5C2C5b8C2a402be35",
    42161: "0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1",
  }, // DAI
  "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599": {
    10: "0x68f180fcCe6836688e9084f035309E29Bf0A2095",
    137: "0x1bfd67037b42cf73acf2047067bd4f2c47d9bfd6",
    288: "0xdc0486f8bf31DF57a952bcd3c1d3e166e3d9eC8b",
    42161: "0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f",
  }, // WBTC
};
