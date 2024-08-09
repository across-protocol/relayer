import { SUPPORTED_TOKENS, CUSTOM_BRIDGE, CANONICAL_BRIDGE, DEFAULT_GAS_MULTIPLIER } from "../../common";
import { CHAIN_IDs, TOKEN_SYMBOLS_MAP, winston } from "../../utils";
import { SpokePoolClient } from "../SpokePoolClient";
import { BaseChainAdapter } from "../../adapter/BaseChainAdapter";

export class ZKSyncAdapter extends BaseChainAdapter {
  constructor(
    logger: winston.Logger,
    readonly spokePoolClients: { [chainId: number]: SpokePoolClient },
    monitoredAddresses: string[]
  ) {
    const { ZK_SYNC, MAINNET } = CHAIN_IDs;
    const bridges = {};
    const l2Signer = spokePoolClients[ZK_SYNC].spokePool.signer;
    const l1Signer = spokePoolClients[MAINNET].spokePool.signer;
    SUPPORTED_TOKENS[ZK_SYNC]?.map((symbol) => {
      const l1Token = TOKEN_SYMBOLS_MAP[symbol].addresses[MAINNET];
      const bridgeConstructor = CUSTOM_BRIDGE[ZK_SYNC]?.[l1Token] ?? CANONICAL_BRIDGE[ZK_SYNC];
      bridges[l1Token] = new bridgeConstructor(ZK_SYNC, MAINNET, l1Signer, l2Signer, l1Token);
    });
    super(
      spokePoolClients,
      ZK_SYNC,
      MAINNET,
      monitoredAddresses,
      logger,
      SUPPORTED_TOKENS[ZK_SYNC],
      bridges,
      DEFAULT_GAS_MULTIPLIER[ZK_SYNC] ?? 1
    );
  }
}
