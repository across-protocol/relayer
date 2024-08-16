import { SUPPORTED_TOKENS, CUSTOM_BRIDGE, CANONICAL_BRIDGE, DEFAULT_GAS_MULTIPLIER } from "../../common";
import { CHAIN_IDs, TOKEN_SYMBOLS_MAP, winston } from "../../utils";
import { SpokePoolClient } from "../SpokePoolClient";
import { BaseChainAdapter } from "../../adapter/BaseChainAdapter";

export class PolygonAdapter extends BaseChainAdapter {
  constructor(
    logger: winston.Logger,
    readonly spokePoolClients: { [chainId: number]: SpokePoolClient },
    monitoredAddresses: string[]
  ) {
    const { POLYGON, MAINNET } = CHAIN_IDs;
    const bridges = {};
    const l2Signer = spokePoolClients[POLYGON].spokePool.signer;
    const l1Signer = spokePoolClients[MAINNET].spokePool.signer;
    SUPPORTED_TOKENS[POLYGON]?.map((symbol) => {
      const l1Token = TOKEN_SYMBOLS_MAP[symbol].addresses[MAINNET];
      const bridgeConstructor = CUSTOM_BRIDGE[POLYGON]?.[l1Token] ?? CANONICAL_BRIDGE[POLYGON];
      bridges[l1Token] = new bridgeConstructor(POLYGON, MAINNET, l1Signer, l2Signer, l1Token);
    });
    super(
      spokePoolClients,
      POLYGON,
      MAINNET,
      monitoredAddresses,
      logger,
      SUPPORTED_TOKENS[POLYGON],
      bridges,
      DEFAULT_GAS_MULTIPLIER[POLYGON] ?? 1
    );
  }
}
