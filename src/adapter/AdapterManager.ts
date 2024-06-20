import {
  BigNumber,
  isDefined,
  winston,
  Signer,
  getL2TokenAddresses,
  TransactionResponse,
  assert,
  CHAIN_IDs,
  mapAsync,
  TOKEN_SYMBOLS_MAP,
  chainIsMatic,
} from "../utils";
import { SpokePoolClient, HubPoolClient } from "../clients";
import { BaseChainAdapter } from "./";
import { InventoryConfig, OutstandingTransfers } from "../interfaces";
import {
  spokesThatHoldEthAndWeth,
  SUPPORTED_TOKENS,
  DEFAULT_GAS_FEE_SCALERS,
  DEFAULT_RELAYER_GAS_MULTIPLIER,
  CUSTOM_BRIDGE,
  CANONICAL_BRIDGE,
} from "../common";

export class AdapterManager {
  public adapters: { [chainId: number]: BaseChainAdapter } = {};

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
    const spokePoolAddresses = Object.values(spokePoolClients).map((client) => client.spokePool.address);
    const hubChainId = this.hubPoolClient.chainId;

    // The adapters are only set up to monitor EOA's and the HubPool and SpokePool address, so remove
    // spoke pool addresses from other chains.
    const filterMonitoredAddresses = (chainId: number) => {
      return monitoredAddresses.filter(
        (address) =>
          this.hubPoolClient.hubPool.address === address ||
          this.spokePoolClients[chainId].spokePool.address === address ||
          !spokePoolAddresses.includes(address)
      );
    };

    const l1Signer = spokePoolClients[hubChainId].spokePool.signer;

    Object.values(CHAIN_IDs)
      .filter((chainId) => isDefined(this.spokePoolClients[chainId]) && chainId !== hubChainId)
      .map((chainId) => {
        // First, fetch all the bridges associated with the chain.
        const bridges = {};
        const l2Signer = spokePoolClients[chainId].spokePool.signer;

        SUPPORTED_TOKENS[chainId].map((symbol) => {
          const l1Token = TOKEN_SYMBOLS_MAP[symbol].addresses[hubChainId];
          const bridgeConstructor = CUSTOM_BRIDGE[chainId][l1Token] ?? CANONICAL_BRIDGE[chainId];

          // For bridges like Arbitrum and Polygon, we need to supply additional information about the token
          // so that we may properly select the l1Gateway
          if (chainIsMatic(chainId) && !CUSTOM_BRIDGE[chainId]?.[l1Token]) {
            bridges[l1Token] = new bridgeConstructor(
              chainId,
              hubChainId,
              l1Signer,
              l2Signer,
              this.l2TokenForL1Token(l1Token, chainId)
            );
          } else {
            bridges[l1Token] = new bridgeConstructor(chainId, hubChainId, l1Signer, l2Signer, l1Token);
          }
        });

        // Then instantiate a generic adapter.
        // TODO: Do something about the gas multiplier
        this.adapters[chainId] = new BaseChainAdapter(
          spokePoolClients,
          chainId,
          hubChainId,
          filterMonitoredAddresses(chainId),
          logger,
          SUPPORTED_TOKENS[chainId],
          bridges,
          DEFAULT_GAS_FEE_SCALERS[hubChainId]?.maxFeePerGasScaler ?? Number(DEFAULT_RELAYER_GAS_MULTIPLIER)
        );
      });

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

  getOutstandingCrossChainTokenTransferAmount(chainId: number, l1Tokens: string[]): Promise<OutstandingTransfers> {
    const hubChainId = this.hubPoolClient.chainId;
    const adapter = this.adapters[chainId];
    // @dev The adapter should filter out tokens that are not supported by the adapter, but we do it here as well.
    const adapterSupportedL1Tokens = l1Tokens.filter((token) =>
      adapter.supportedTokens.includes(this.hubPoolClient.getTokenInfo(hubChainId, token).symbol)
    );
    this.logger.debug({
      at: "AdapterManager",
      message: `Getting outstandingCrossChainTransfers for ${chainId}`,
      adapterSupportedL1Tokens,
      searchConfigs: adapter.getUpdatedSearchConfigs(),
    });
    return this.adapters[chainId].getOutstandingCrossChainTransfers(adapterSupportedL1Tokens);
  }

  sendTokenCrossChain(
    address: string,
    chainId: number,
    l1Token: string,
    amount: BigNumber,
    simMode = false,
    l2Token?: string
  ): Promise<TransactionResponse> {
    this.logger.debug({ at: "AdapterManager", message: "Sending token cross-chain", chainId, l1Token, amount });
    l2Token ??= this.l2TokenForL1Token(l1Token, Number(chainId));
    return this.adapters[chainId].sendTokenToTargetChain(address, l1Token, l2Token, amount, simMode);
  }

  // Check how much ETH is on the target chain and if it is above the threshold the wrap it to WETH. Note that this only
  // needs to be done on chains where rebalancing WETH from L1 to L2 results in the relayer receiving ETH
  // (not the ERC20), or if the relayer expects to be sent ETH perhaps as a gas refund from an original L1 to L2
  // deposit. This currently happens on Arbitrum, where the relayer address is set as the Arbitrum_Adapter's
  // L2 refund recipient, and on ZkSync, because the relayer is set as the refund recipient when rebalancing
  // inventory from L1 to ZkSync via the AtomicDepositor.
  async wrapEthIfAboveThreshold(inventoryConfig: InventoryConfig, simMode = false): Promise<void> {
    await mapAsync(
      this.chainsToWrapEtherOn.filter((chainId) => isDefined(this.spokePoolClients[chainId])),
      async (chainId) => {
        const wrapThreshold =
          inventoryConfig?.wrapEtherThresholdPerChain?.[chainId] ?? inventoryConfig.wrapEtherThreshold;
        const wrapTarget = inventoryConfig?.wrapEtherTargetPerChain?.[chainId] ?? inventoryConfig.wrapEtherTarget;
        assert(
          wrapThreshold.gte(wrapTarget),
          `wrapEtherThreshold ${wrapThreshold} must be >= wrapEtherTarget ${wrapTarget}`
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
      const l2TokenForL1Token = this.hubPoolClient.getL2TokenForL1TokenAtBlock(l1Token, chainId);
      if (!l2TokenForL1Token) {
        throw new Error(`No L2 token found for L1 token ${l1Token} on chain ${chainId}`);
      }
      if (l2TokenForL1Token !== getL2TokenAddresses(l1Token)[chainId]) {
        throw new Error(`Token address mismatch (${l2TokenForL1Token} != ${getL2TokenAddresses(l1Token)[chainId]})`);
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

  async setL1TokenApprovals(l1Tokens: string[]): Promise<void> {
    // Each of these calls must happen sequentially or we'll have collisions within the TransactionUtil. This should
    // be refactored in a follow on PR to separate out by nonce increment by making the transaction util stateful.
    for (const chainId of this.supportedChains()) {
      const adapter = this.adapters[chainId];
      if (isDefined(adapter)) {
        const hubTokens = l1Tokens.filter((token) => this.l2TokenExistForL1Token(token, chainId));
        await adapter.checkTokenApprovals(hubTokens);
      }
    }
  }

  l2TokenExistForL1Token(l1Token: string, l2ChainId: number): boolean {
    return this.hubPoolClient.l2TokenEnabledForL1Token(l1Token, l2ChainId);
  }

  // eslint-disable-next-line @typescript-eslint/no-empty-function
  async update(): Promise<void> {}
}
