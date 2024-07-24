import { SUPPORTED_TOKENS, CUSTOM_BRIDGE, CANONICAL_BRIDGE, DEFAULT_GAS_MULTIPLIER } from "../../common";
import { CHAIN_IDs, TOKEN_SYMBOLS_MAP, winston } from "../../utils";
import { SpokePoolClient } from "../SpokePoolClient";
import { BaseChainAdapter } from "../../adapter/BaseChainAdapter";

export class ScrollAdapter extends BaseChainAdapter {
  constructor(
    logger: winston.Logger,
    readonly spokePoolClients: { [chainId: number]: SpokePoolClient },
    monitoredAddresses: string[]
  ) {
    const { SCROLL, MAINNET } = CHAIN_IDs;
    const bridges = {};
    const l2Signer = spokePoolClients[SCROLL].spokePool.signer;
    const l1Signer = spokePoolClients[MAINNET].spokePool.signer;
    SUPPORTED_TOKENS[SCROLL]?.map((symbol) => {
      const l1Token = TOKEN_SYMBOLS_MAP[symbol].addresses[MAINNET];
      const bridgeConstructor = CUSTOM_BRIDGE[SCROLL][l1Token] ?? CANONICAL_BRIDGE[SCROLL];
      bridges[l1Token] = new bridgeConstructor(SCROLL, MAINNET, l1Signer, l2Signer, l1Token);
    });
    super(
      spokePoolClients,
      SCROLL,
      MAINNET,
      monitoredAddresses,
      logger,
      SUPPORTED_TOKENS[SCROLL],
      bridges,
      DEFAULT_GAS_MULTIPLIER[SCROLL] ?? 1
    );
  }
}
