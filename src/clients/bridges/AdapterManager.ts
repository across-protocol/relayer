import { BigNumber, isDefined, winston, Signer, getL2TokenAddresses, TransactionResponse, assert } from "../../utils";
import { SpokePoolClient, HubPoolClient } from "../";
import { OptimismAdapter, ArbitrumAdapter, PolygonAdapter, BaseAdapter, ZKSyncAdapter } from "./";
import { InventoryConfig, OutstandingTransfers } from "../../interfaces";
import { utils } from "@across-protocol/sdk-v2";
import { CHAIN_IDs } from "@across-protocol/constants-v2";
import { BaseChainAdapter } from "./op-stack/base/BaseChainAdapter";
import { spokesThatHoldEthAndWeth } from "../../common/Constants";
export class AdapterManager {
  public adapters: { [chainId: number]: BaseAdapter } = {};

  // Some L2's canonical bridges send ETH, not WETH, over the canonical bridges, resulting in recipient addresses
  // receiving ETH that needs to be wrapped on the L2. This array contains the chainIds of the chains that this
  // manager will attempt to wrap ETH on into WETH. This list also includes chains like Arbitrum where the relayer is
  // expected to receive ETH as a gas refund from an L1 to L2 deposit that was intended to rebalance inventory.
  public chainsToWrapEtherOn = [...spokesThatHoldEthAndWeth, CHAIN_IDs.ARBITRUM];

  constructor(
    readonly logger: winston.Logger,
    readonly spokePoolClients: { [chainId: number]: SpokePoolClient },
    readonly hubPoolClient: HubPoolClient,
    readonly monitoredAddresses: string[]
  ) {
    if (!spokePoolClients) {
      return;
    }
    if (this.spokePoolClients[10] !== undefined) {
      this.adapters[10] = new OptimismAdapter(logger, spokePoolClients, monitoredAddresses);
    }
    if (this.spokePoolClients[137] !== undefined) {
      this.adapters[137] = new PolygonAdapter(logger, spokePoolClients, monitoredAddresses);
    }
    if (this.spokePoolClients[42161] !== undefined) {
      this.adapters[42161] = new ArbitrumAdapter(logger, spokePoolClients, monitoredAddresses);
    }
    if (this.spokePoolClients[324] !== undefined) {
      this.adapters[324] = new ZKSyncAdapter(logger, spokePoolClients, monitoredAddresses);
    }
    if (this.spokePoolClients[8453] !== undefined) {
      this.adapters[8453] = new BaseChainAdapter(logger, spokePoolClients, monitoredAddresses);
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
    amount: BigNumber,
    simMode = false
  ): Promise<TransactionResponse> {
    chainId = Number(chainId); // Ensure chainId is a number before using.
    this.logger.debug({ at: "AdapterManager", message: "Sending token cross-chain", chainId, l1Token, amount });
    const l2Token = this.l2TokenForL1Token(l1Token, Number(chainId));
    return await this.adapters[chainId].sendTokenToTargetChain(address, l1Token, l2Token, amount, simMode);
  }

  // Check how much ETH is on the target chain and if it is above the threshold the wrap it to WETH. Note that this only
  // needs to be done on chains where rebalancing WETH from L1 to L2 results in the relayer receiving ETH
  // (not the ERC20), or if the relayer expects to be sent ETH perhaps as a gas refund from an original L1 to L2
  // deposit.
  async wrapEthIfAboveThreshold(inventoryConfig: InventoryConfig, simMode = false): Promise<void> {
    await utils.mapAsync(
      this.chainsToWrapEtherOn.filter((chainId) => isDefined(this.spokePoolClients[chainId])),
      async (chainId) => {
        const wrapThreshold = inventoryConfig.wrapEtherThresholdPerChain[chainId] ?? inventoryConfig.wrapEtherThreshold;
        const wrapTarget = inventoryConfig.wrapEtherTargetPerChain[chainId] ?? inventoryConfig.wrapEtherTarget;
        assert(
          wrapThreshold.gte(wrapTarget),
          `wrapEtherThreshold ${wrapThreshold.toString()} must be >= wrapEtherTarget ${wrapTarget.toString()}`
        );
        await this.adapters[chainId].wrapEthIfAboveThreshold(wrapThreshold, wrapTarget, simMode);
      }
    );
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
        throw new Error(`No L2 token found for L1 token ${l1Token} on chain ${chainId}`);
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
    for (const chainId of this.supportedChains()) {
      const adapter = this.adapters[chainId];
      if (isDefined(adapter)) {
        const hubTokens = l1Tokens.filter((token) => this.l2TokenExistForL1Token(token, chainId));
        await adapter.checkTokenApprovals(address, hubTokens);
      }
    }
  }

  l2TokenExistForL1Token(l1Token: string, l2ChainId: number): boolean {
    return this.hubPoolClient.l2TokenEnabledForL1Token(l1Token, l2ChainId);
  }

  // eslint-disable-next-line @typescript-eslint/no-empty-function
  async update(): Promise<void> {}
}
