import { CHAIN_IDs, TOKEN_SYMBOLS_MAP } from "@across-protocol/constants";
import { OFTL2Bridge } from "../../src/adapter/l2Bridges/OFTL2Bridge";
import { ethers, expect, randomAddress, toBNWei } from "../utils";
import { EvmAddress } from "../../src/utils/SDKUtils";
import { PendingBridgeRedisReader } from "../../src/rebalancer/utils/PendingBridgeRedis";
import * as OFTUtils from "../../src/utils/OFTUtils";

describe("Cross Chain Adapter: OFT L2 Bridge", function () {
  it("ignores rebalancer-owned pending withdrawals", async function () {
    const [signer] = await ethers.getSigners();
    const hubChainId = CHAIN_IDs.MAINNET;
    const l2ChainId = CHAIN_IDs.ARBITRUM;
    const l1Token = EvmAddress.from(TOKEN_SYMBOLS_MAP.USDT.addresses[hubChainId]);
    const adapter = new OFTL2Bridge(l2ChainId, hubChainId, signer, signer, l1Token);
    const fromAddress = EvmAddress.from(randomAddress());
    const amountToWithdraw = toBNWei("100", 6);
    const guid = "0x" + "12".repeat(32);

    adapter.setPendingBridgeRedisReader({
      getPendingBridgeTxnRefsForRoute: async () => new Set(["tracked-txn"]),
    } as unknown as PendingBridgeRedisReader);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (adapter as any).l2Bridge.queryFilter = async () => [
      {
        event: "OFTSent",
        blockNumber: 1,
        transactionHash: "tracked-txn",
        txnRef: "tracked-txn",
        args: {
          dstEid: OFTUtils.getEndpointId(hubChainId),
          guid,
          amountReceivedLD: amountToWithdraw,
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any,
    ];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (adapter as any).l1Bridge.queryFilter = async () => [];

    const amount = await adapter.getL2PendingWithdrawalAmount(
      { from: 0, to: 1000 },
      { from: 0, to: 1000 },
      fromAddress,
      adapter.l2Token
    );

    expect(amount).to.equal(0);
  });
});
