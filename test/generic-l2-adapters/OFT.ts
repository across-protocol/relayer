import { CHAIN_IDs, TOKEN_SYMBOLS_MAP } from "@across-protocol/constants";
import { OFTL2Bridge } from "../../src/adapter/l2Bridges/OFTL2Bridge";
import { ethers, expect, randomAddress, toBNWei } from "../utils";
import { EvmAddress } from "../../src/utils/SDKUtils";
import { CctpOftReadOnlyClient } from "../../src/rebalancer/clients/CctpOftReadOnlyClient";
import * as OFTUtils from "../../src/utils/OFTUtils";

describe("Cross Chain Adapter: OFT L2 Bridge", function () {
  describe("sizes withdrawals to the bridge's quoted capacity", function () {
    const hubChainId = CHAIN_IDs.MAINNET;
    const l2ChainId = CHAIN_IDs.PLASMA;
    const l1Token = EvmAddress.from(TOKEN_SYMBOLS_MAP.WETH.addresses[CHAIN_IDs.MAINNET]);
    const nativeFee = toBNWei("1");
    let adapter: OFTL2Bridge;
    let toAddress: EvmAddress;

    // Replaces the l2Bridge contract with a mock whose quoteOFT reports `capacity` as the max
    // sendable amount, mirroring how Stargate caps `amountSentLD` at the path's available credit.
    // Ethers contract methods are read-only properties, so the whole object is swapped out.
    const mockBridgeCapacity = (capacity: ReturnType<typeof toBNWei>) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const realBridge = (adapter as any).l2Bridge;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (adapter as any).l2Bridge = {
        address: realBridge.address,
        signer: realBridge.signer,
        sharedDecimals: async () => 6,
        quoteSend: async () => ({ nativeFee, lzTokenFee: 0 }),
        quoteOFT: async (sendParam: OFTUtils.SendParamStruct) => {
          const requested = ethers.BigNumber.from(sendParam.amountLD);
          const amountSentLD = requested.lt(capacity) ? requested : capacity;
          return [
            { minAmountLD: toBNWei("0.000001"), maxAmountLD: capacity },
            [],
            { amountSentLD, amountReceivedLD: amountSentLD },
          ];
        },
      };
    };

    beforeEach(async function () {
      const [signer] = await ethers.getSigners();
      adapter = new OFTL2Bridge(l2ChainId, hubChainId, signer, signer, l1Token);
      toAddress = EvmAddress.from(randomAddress());
    });

    it("sizes the withdrawal down when capacity is below the requested amount", async function () {
      mockBridgeCapacity(toBNWei("5"));
      const txns = await adapter.constructWithdrawToL1Txns(toAddress, adapter.l2Token, l1Token, toBNWei("20"));
      expect(txns.length).to.equal(1);
      const [sendParam] = txns[0].args;
      expect(sendParam.amountLD).to.equal(toBNWei("5"));
      // Plasma is a Stargate bridge, so minAmountLD allows for the 0.5% max fee on the sized-down amount.
      expect(sendParam.minAmountLD).to.equal(toBNWei("5").sub(toBNWei("5").mul(5).div(1000)));
      expect(txns[0].mrkdwn).to.contain("sized down to current bridge capacity");
    });

    it("sends the full amount when capacity is not binding", async function () {
      mockBridgeCapacity(toBNWei("100"));
      const txns = await adapter.constructWithdrawToL1Txns(toAddress, adapter.l2Token, l1Token, toBNWei("20"));
      expect(txns.length).to.equal(1);
      const [sendParam] = txns[0].args;
      expect(sendParam.amountLD).to.equal(toBNWei("20"));
      expect(txns[0].mrkdwn).to.not.contain("sized down");
    });

    it("returns no transactions when the bridge has no usable capacity", async function () {
      mockBridgeCapacity(toBNWei("0"));
      const txns = await adapter.constructWithdrawToL1Txns(toAddress, adapter.l2Token, l1Token, toBNWei("20"));
      expect(txns.length).to.equal(0);
    });
  });

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
    } as unknown as CctpOftReadOnlyClient);

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
