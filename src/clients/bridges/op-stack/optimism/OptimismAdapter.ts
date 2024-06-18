import { winston, TOKEN_SYMBOLS_MAP, CHAIN_IDs } from "../../../../utils";
import { SpokePoolClient } from "../../..";
import { BaseAdapter } from "../..";
import { SUPPORTED_TOKENS } from "../../../../common";
import { OpStackAdapter } from "../OpStackAdapter";
import { DaiOptimismBridge } from "./DaiOptimismBridge";
import { SnxOptimismBridge } from "./SnxOptimismBridge";

export class OptimismAdapter extends OpStackAdapter {
  constructor(
    logger: winston.Logger,
    readonly spokePoolClients: { [chainId: number]: SpokePoolClient },
    monitoredAddresses: string[]
  ) {
    const hubChainId = BaseAdapter.HUB_CHAIN_ID;
    const l2ChainId = 10;
    const hubChainSigner = spokePoolClients[hubChainId].spokePool.signer;
    const l2Signer = spokePoolClients[l2ChainId].spokePool.signer;
    const daiBridge = new DaiOptimismBridge(l2ChainId, hubChainId, hubChainSigner, l2Signer);
    const snxBridge = new SnxOptimismBridge(l2ChainId, hubChainId, hubChainSigner, l2Signer);
    super(
      10,
      {
        [TOKEN_SYMBOLS_MAP.DAI.addresses[hubChainId]]: daiBridge,
        [TOKEN_SYMBOLS_MAP.SNX.addresses[hubChainId]]: snxBridge,
      },
      logger,
      SUPPORTED_TOKENS[CHAIN_IDs.OPTIMISM],
      spokePoolClients,
      monitoredAddresses
    );
  }
}
