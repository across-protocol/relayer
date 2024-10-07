import { SUPPORTED_TOKENS, CUSTOM_BRIDGE, CANONICAL_BRIDGE, DEFAULT_GAS_MULTIPLIER } from "../../common";
import { CHAIN_IDs, TOKEN_SYMBOLS_MAP, winston } from "../../utils";
import { SpokePoolClient } from "../SpokePoolClient";
import { BaseChainAdapter } from "../../adapter/BaseChainAdapter";

export class ArbitrumAdapter extends BaseChainAdapter {
  constructor(
    logger: winston.Logger,
    readonly spokePoolClients: { [chainId: number]: SpokePoolClient },
    monitoredAddresses: string[]
  ) {
    const { ARBITRUM, MAINNET } = CHAIN_IDs;
    const bridges = {};
    const l2Signer = spokePoolClients[ARBITRUM].spokePool.signer;
    const l1Signer = spokePoolClients[MAINNET].spokePool.signer;
    SUPPORTED_TOKENS[ARBITRUM]?.map((symbol) => {
      const l1Token = TOKEN_SYMBOLS_MAP[symbol].addresses[MAINNET];
      const bridgeConstructor = CUSTOM_BRIDGE[ARBITRUM]?.[l1Token] ?? CANONICAL_BRIDGE[ARBITRUM];
      bridges[l1Token] = new bridgeConstructor(ARBITRUM, MAINNET, l1Signer, l2Signer, l1Token);
    });
    super(
      spokePoolClients,
      ARBITRUM,
      MAINNET,
      monitoredAddresses,
      logger,
      SUPPORTED_TOKENS[ARBITRUM],
      bridges,
      DEFAULT_GAS_MULTIPLIER[ARBITRUM] ?? 1
    );
  }
}
