import { BinanceStablecoinSwapAdapter, BridgeTransferDeclinedError } from "../src/adapter/bridges";
import { RebalanceRoute } from "../src/rebalancer/utils/interfaces";
import { CHAIN_IDs, EvmAddress, TOKEN_SYMBOLS_MAP, ZERO_BYTES } from "../src/utils";
import { createSpyLogger, ethers, expect, toBNWei } from "./utils";

describe("BinanceStablecoinSwapAdapter bridge", function () {
  const route: RebalanceRoute = {
    sourceChain: CHAIN_IDs.MAINNET,
    sourceToken: "USDT",
    destinationChain: CHAIN_IDs.AVALANCHE,
    destinationToken: "USDT",
    adapter: "binance",
  };

  async function makeBridge(
    options: {
      pending?: number;
      cost?: string;
      initialize?: boolean;
      error?: Error;
      maxPendingOrders?: number;
    } = {}
  ) {
    const [signer, other] = await ethers.getSigners();
    const { spyLogger } = createSpyLogger();
    const baseSignerAddress = EvmAddress.from(signer.address);
    const adapter = {
      baseSignerAddress,
      config: {
        maxAmountsToTransfer: {},
        maxPendingOrders: { binance: options.maxPendingOrders ?? 2 },
      },
      supportsRoute: () => true,
      getPendingOrders: async () => Array.from({ length: options.pending ?? 0 }, (_, index) => `order-${index}`),
      getEstimatedCost: async () => toBNWei(options.cost ?? "0", 6),
      initializeRebalanceWithTransaction: async (_route: RebalanceRoute, amount: ReturnType<typeof toBNWei>) => {
        if (options.error) {
          throw options.error;
        }
        return {
          amount: options.initialize === false ? toBNWei("0", 6) : amount,
          transactionHash: options.initialize === false ? undefined : "0xdeposit",
        };
      },
    };
    const bridge = new BinanceStablecoinSwapAdapter(
      CHAIN_IDs.AVALANCHE,
      CHAIN_IDs.MAINNET,
      signer,
      signer,
      EvmAddress.from(TOKEN_SYMBOLS_MAP.USDT.addresses[CHAIN_IDs.MAINNET]),
      spyLogger
    );
    Object.assign(bridge, { adapter, route });
    return {
      bridge,
      signer: baseSignerAddress,
      other: EvmAddress.from(other.address),
      l1Token: EvmAddress.from(TOKEN_SYMBOLS_MAP.USDT.addresses[CHAIN_IDs.MAINNET]),
      l2Token: EvmAddress.from(TOKEN_SYMBOLS_MAP.USDT.addresses[CHAIN_IDs.AVALANCHE]),
    };
  }

  it("returns the Binance deposit transaction hash", async function () {
    const { bridge, signer, l1Token, l2Token } = await makeBridge();
    const amount = toBNWei("100", 6);

    expect((await bridge.sendL1ToL2Transfer(signer, l1Token, l2Token, amount, false)).hash).to.equal("0xdeposit");
    expect((await bridge.sendL1ToL2Transfer(signer, l1Token, l2Token, amount, true)).hash).to.equal(ZERO_BYTES);
  });

  it("declines expensive or capacity-limited transfers without moving funds", async function () {
    const amount = toBNWei("100", 6);

    const expensive = await makeBridge({ cost: "3" });
    await expect(
      expensive.bridge.sendL1ToL2Transfer(expensive.signer, expensive.l1Token, expensive.l2Token, amount, false)
    ).to.be.rejectedWith(BridgeTransferDeclinedError);

    const full = await makeBridge({ pending: 2 });
    await expect(
      full.bridge.sendL1ToL2Transfer(full.signer, full.l1Token, full.l2Token, amount, false)
    ).to.be.rejectedWith(BridgeTransferDeclinedError);

    const declined = await makeBridge({ initialize: false });
    await expect(
      declined.bridge.sendL1ToL2Transfer(declined.signer, declined.l1Token, declined.l2Token, amount, false)
    ).to.be.rejectedWith(BridgeTransferDeclinedError);

    // A submission error is not a decline: funds may have moved, so callers must not roll back accounting.
    const failed = await makeBridge({ error: new Error("confirmation unavailable") });
    await expect(
      failed.bridge.sendL1ToL2Transfer(failed.signer, failed.l1Token, failed.l2Token, amount, false)
    ).to.be.rejectedWith("confirmation unavailable");
  });

  it("rejects a withdrawal recipient other than the signer", async function () {
    const { bridge, other, l1Token, l2Token } = await makeBridge();
    await expect(bridge.sendL1ToL2Transfer(other, l1Token, l2Token, toBNWei("100", 6), false)).to.be.rejectedWith(
      "Binance withdrawal recipient must match signer"
    );
  });

  it("leaves bridge-event accounting to Redis-backed pending rebalances", async function () {
    const { bridge, signer, l1Token } = await makeBridge();
    const eventConfig = { from: 0, to: 0, maxBlockLookBack: 1 };

    expect(await bridge.queryL1BridgeInitiationEvents(l1Token, signer, signer, eventConfig)).to.deep.equal({});
    expect(await bridge.queryL2BridgeFinalizationEvents(l1Token, signer, signer, eventConfig)).to.deep.equal({});
  });
});
