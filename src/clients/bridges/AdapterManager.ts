import {
  BigNumber,
  winston,
  toBN,
  createFormatFunction,
  etherscanLink,
  Signer,
  getL2TokenAddresses,
  TransactionResponse,
} from "../../utils";
import { SpokePoolClient, HubPoolClient } from "../";
import { OptimismAdapter, ArbitrumAdapter, PolygonAdapter } from "./";
import { OutstandingTransfers } from "../../interfaces";
export class AdapterManager {
  public adapters: { [chainId: number]: OptimismAdapter | ArbitrumAdapter | PolygonAdapter } = {};

  constructor(
    readonly logger: winston.Logger,
    readonly spokePoolClients: { [chainId: number]: SpokePoolClient },
    readonly hubPoolClient: HubPoolClient,
    readonly monitoredAddresses: string[],
    // Optional sender address where the cross chain transfers originate from. This is useful for the use case of
    // monitoring transfers from HubPool to SpokePools where the sender is HubPool.
    readonly senderAddress?: string
  ) {
    if (!spokePoolClients) {
      return;
    }
    if (this.spokePoolClients[10] !== undefined) {
      this.adapters[10] = new OptimismAdapter(logger, spokePoolClients, monitoredAddresses, senderAddress);
    }
    if (this.spokePoolClients[137] !== undefined) {
      this.adapters[137] = new PolygonAdapter(logger, spokePoolClients, monitoredAddresses);
    }
    if (this.spokePoolClients[42161] !== undefined) {
      this.adapters[42161] = new ArbitrumAdapter(logger, spokePoolClients, monitoredAddresses);
    }

    logger.debug({
      at: "AdapterManager#constructor",
      message: "Initialized AdapterManager",
      adapterChains: Object.keys(this.adapters).map((chainId) => Number(chainId)),
    });
  }

  /**
   * @notice Returns list of chains we have adapters for
   * @returns list of chain IDs we have adapters for
   */
  supportedChains(): number[] {
    return Object.keys(this.adapters).map((chainId) => Number(chainId));
  }

  async getOutstandingCrossChainTokenTransferAmount(
    chainId: number,
    l1Tokens: string[]
  ): Promise<OutstandingTransfers> {
    this.logger.debug({ at: "AdapterManager", message: "Getting outstandingCrossChainTransfers", chainId, l1Tokens });
    return await this.adapters[chainId].getOutstandingCrossChainTransfers(l1Tokens);
  }

  async sendTokenCrossChain(
    address: string,
    chainId: number | string,
    l1Token: string,
    amount: BigNumber
  ): Promise<TransactionResponse> {
    chainId = Number(chainId); // Ensure chainId is a number before using.
    this.logger.debug({ at: "AdapterManager", message: "Sending token cross-chain", chainId, l1Token, amount });
    const l2Token = this.l2TokenForL1Token(l1Token, Number(chainId));
    return await this.adapters[chainId].sendTokenToTargetChain(address, l1Token, l2Token, amount);
  }

  // Check how much ETH is on the target chain and if it is above the threshold the wrap it to WETH. Note that this only
  // needs to e done on Boba and Optimism as only these two chains require ETH to be sent over the canonical bridge.
  async wrapEthIfAboveThreshold(wrapThreshold: BigNumber): Promise<void> {
    const optimismCall =
      this.spokePoolClients[10] !== undefined
        ? (this.adapters[10] as OptimismAdapter).wrapEthIfAboveThreshold(wrapThreshold)
        : Promise.resolve(undefined);
    const [optimismWrapTx] = await Promise.all([optimismCall]);

    if (optimismWrapTx) {
      const mrkdwn =
        "Ether on Optimism was wrapped due to being over the threshold of " +
        `${createFormatFunction(2, 4, false, 18)(toBN(wrapThreshold).toString())} ETH.\n` +
        `${`\nOptimism tx: ${etherscanLink(optimismWrapTx.hash, 10)} `}.`;
      this.logger.info({ at: "AdapterManager", message: "Eth wrapped on target chain 🎁", mrkdwn });
    }
  }

  getSigner(chainId: number): Signer {
    return this.spokePoolClients[chainId].spokePool.signer;
  }

  l2TokenForL1Token(l1Token: string, chainId: number): string {
    // the try catch below is a safety hatch. If you try fetch an L2 token that is not within the hubPoolClient for a
    // given L1Token and chainId combo then you are likely trying to send a token to a chain that does not support it.
    try {
      // That the line below is critical. if the hubpoolClient returns the wrong destination token for the L1 token then
      // the bot can irrecoverably send the wrong token to the chain and loose money. It should crash if this is detected.
      const l2TokenForL1Token = this.hubPoolClient.getDestinationTokenForL1Token(l1Token, chainId);
      if (!l2TokenForL1Token) {
        throw new Error("No L2 token found for L1 token");
      }
      if (l2TokenForL1Token !== getL2TokenAddresses(l1Token)[chainId]) {
        throw new Error("Mismatch tokens!");
      }
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

  async setL1TokenApprovals(address: string, l1Tokens: string[]): Promise<void> {
    // Each of these calls must happen sequentially or we'll have collisions within the TransactionUtil. This should
    // be refactored in a follow on PR to separate out by nonce increment by making the transaction util stateful.
    if (this.adapters[10] !== undefined) {
      await this.adapters[10].checkTokenApprovals(
        address,
        l1Tokens.filter((token) => this.l2TokenExistForL1Token(token, 10))
      );
    }

    if (this.adapters[137] !== undefined) {
      await this.adapters[137].checkTokenApprovals(
        address,
        l1Tokens.filter((token) => this.l2TokenExistForL1Token(token, 137))
      );
    }

    if (this.adapters[42161] !== undefined) {
      await this.adapters[42161].checkTokenApprovals(
        address,
        l1Tokens.filter((token) => this.l2TokenExistForL1Token(token, 42161))
      );
    }
  }

  l2TokenExistForL1Token(l1Token: string, l2ChainId: number): boolean {
    return this.hubPoolClient.l2TokenEnabledForL1Token(l1Token, l2ChainId);
  }

  // eslint-disable-next-line @typescript-eslint/no-empty-function
  async update(): Promise<void> {}
}
