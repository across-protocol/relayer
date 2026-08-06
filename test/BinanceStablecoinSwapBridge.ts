import { BinanceStablecoinSwapAdapter } from "../src/adapter/bridges";
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

  async function makeBridge(options: { pending?: number; cost?: string; maxAmount?: string; valid?: boolean } = {}) {
    const [signer, other] = await ethers.getSigners();
    const { spyLogger } = createSpyLogger();
    const baseSignerAddress = EvmAddress.from(signer.address);
    const adapter = {
      baseSignerAddress,
      config: {
        maxAmountsToTransfer: options.maxAmount ? { USDT: { [CHAIN_IDs.MAINNET]: toBNWei(options.maxAmount, 6) } } : {},
        maxPendingOrders: { binance: 2 },
      },
      supportsRoute: () => true,
      getPendingOrders: async () => Array.from({ length: options.pending ?? 0 }, (_, i) => String(i)),
      getEstimatedCost: async () => toBNWei(options.cost ?? "0", 6),
      getValidatedRebalanceAmount: async (_route: RebalanceRoute, amount: ReturnType<typeof toBNWei>) =>
        options.valid === false ? toBNWei("0", 6) : amount,
      initializeRebalanceWithTransaction: async (_route: RebalanceRoute, amount: ReturnType<typeof toBNWei>) => ({
        amount,
        transactionHash: "0xdeposit",
      }),
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

  it("caps accepted amounts and returns the Binance deposit transaction hash", async function () {
    const { bridge, signer, l1Token, l2Token } = await makeBridge({ maxAmount: "100" });
    const amount = await bridge.prepareL1ToL2Transfer(signer, l1Token, l2Token, toBNWei("250", 6));

    expect(amount).to.equal(toBNWei("100", 6));
    expect((await bridge.sendL1ToL2Transfer(signer, l1Token, l2Token, amount, false)).hash).to.equal("0xdeposit");
    expect((await bridge.sendL1ToL2Transfer(signer, l1Token, l2Token, amount, true)).hash).to.equal(ZERO_BYTES);
  });

  it("declines expensive or capacity-limited transfers", async function () {
    const expensive = await makeBridge({ cost: "3" });
    expect(
      await expensive.bridge.prepareL1ToL2Transfer(
        expensive.signer,
        expensive.l1Token,
        expensive.l2Token,
        toBNWei("100", 6)
      )
    ).to.equal(0);

    const full = await makeBridge({ pending: 2 });
    expect(
      await full.bridge.prepareL1ToL2Transfer(full.signer, full.l1Token, full.l2Token, toBNWei("100", 6))
    ).to.equal(0);

    const invalid = await makeBridge({ valid: false });
    expect(
      await invalid.bridge.prepareL1ToL2Transfer(invalid.signer, invalid.l1Token, invalid.l2Token, toBNWei("100", 6))
    ).to.equal(0);
  });

  it("rejects a withdrawal recipient other than the signer", async function () {
    const { bridge, other, l1Token, l2Token } = await makeBridge();
    await expect(bridge.prepareL1ToL2Transfer(other, l1Token, l2Token, toBNWei("100", 6))).to.be.rejectedWith(
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
