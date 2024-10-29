import { DEFAULT_GAS_MULTIPLIER } from "../../common";
import { CHAIN_IDs, winston } from "../../utils";
import { SpokePoolClient } from "../SpokePoolClient";
import { BaseChainAdapter } from "../../adapter/BaseChainAdapter";

// This adapter is only used by the AdapterManager to wrap ETH on Mainnet, so we don't pass in any supported
// tokens or bridges.
export class EthereumAdapter extends BaseChainAdapter {
  constructor(
    logger: winston.Logger,
    readonly spokePoolClients: { [chainId: number]: SpokePoolClient }
  ) {
    const { MAINNET } = CHAIN_IDs;
    const bridges = {};
    const supportedTokens = [];
    const monitoredAddresses = [];
    super(
      spokePoolClients,
      MAINNET,
      MAINNET,
      monitoredAddresses,
      logger,
      supportedTokens,
      bridges,
      DEFAULT_GAS_MULTIPLIER[MAINNET] ?? 1
    );
  }
}
