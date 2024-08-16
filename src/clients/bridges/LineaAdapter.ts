import { SUPPORTED_TOKENS, CUSTOM_BRIDGE, CANONICAL_BRIDGE, DEFAULT_GAS_MULTIPLIER } from "../../common";
import { CHAIN_IDs, TOKEN_SYMBOLS_MAP, winston } from "../../utils";
import { SpokePoolClient } from "../SpokePoolClient";
import { BaseChainAdapter } from "../../adapter/BaseChainAdapter";

export class LineaAdapter extends BaseChainAdapter {
  constructor(
    logger: winston.Logger,
    readonly spokePoolClients: { [chainId: number]: SpokePoolClient },
    monitoredAddresses: string[]
  ) {
    const { LINEA, MAINNET } = CHAIN_IDs;
    const l2Signer = spokePoolClients[LINEA].spokePool.signer;
    const l1Signer = spokePoolClients[MAINNET].spokePool.signer;
    const bridges = {};
    SUPPORTED_TOKENS[LINEA]?.forEach((symbol) => {
      const l1Token = TOKEN_SYMBOLS_MAP[symbol].addresses[MAINNET];
      const bridgeConstructor = CUSTOM_BRIDGE[LINEA]?.[l1Token] ?? CANONICAL_BRIDGE[LINEA];
      bridges[l1Token] = new bridgeConstructor(LINEA, MAINNET, l1Signer, l2Signer, l1Token);
    });

    super(
      spokePoolClients,
      LINEA,
      MAINNET,
      monitoredAddresses,
      logger,
      SUPPORTED_TOKENS[LINEA],
      bridges,
      DEFAULT_GAS_MULTIPLIER[LINEA] ?? 1
    );
  }
}
