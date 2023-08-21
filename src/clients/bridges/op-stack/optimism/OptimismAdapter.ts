import { winston } from "../../../../utils";
import { SpokePoolClient } from "../../..";
import { BaseAdapter } from "../..";
import { constants } from "@across-protocol/sdk-v2";
import { OpStackAdapter } from "../OpStackAdapter";
const { TOKEN_SYMBOLS_MAP } = constants;
import { DaiOptimismBridge } from "./DaiOptimismBridge";
import { SnxOptimismBridge } from "./SnxOptimismBridge";

export class OptimismAdapter extends OpStackAdapter {
  constructor(
    logger: winston.Logger,
    readonly spokePoolClients: { [chainId: number]: SpokePoolClient },
    monitoredAddresses: string[],
    // Optional sender address where the cross chain transfers originate from. This is useful for the use case of
    // monitoring transfers from HubPool to SpokePools where the sender is HubPool.
    readonly senderAddress?: string
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
      ["DAI", "SNX", "USDC", "USDT", "WETH", "WBTC", "UMA", "BAL", "ACX", "POOL"],
      spokePoolClients,
      monitoredAddresses,
      senderAddress
    );
  }
}
