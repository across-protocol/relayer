import { BinanceStablecoinSwapBridge, BridgeTransferDeclinedError } from "../src/adapter/bridges";
import { RebalanceRoute } from "../src/rebalancer/utils/interfaces";
import { CHAIN_IDs, EvmAddress, TOKEN_SYMBOLS_MAP, ZERO_BYTES, bnZero } from "../src/utils";
import { createSpyLogger, ethers, expect, toBNWei } from "./utils";

describe("BinanceStablecoinSwapBridge", function () {
  type BridgeOptions = {
    pending?: number;
    cost?: string;
    costError?: Error;
    declineInitialize?: boolean;
    error?: Error;
  };

  async function makeBridge(options: BridgeOptions = {}) {
    const [signer, other] = await ethers.getSigners();
    const { spyLogger } = createSpyLogger();
    const baseSignerAddress = EvmAddress.from(signer.address);
    const adapter = {
      baseSignerAddress,
      config: { maxAmountsToTransfer: {}, maxPendingOrders: {} },
      supportsRoute: () => true,
      getPendingOrders: async () => Array.from({ length: options.pending ?? 0 }, (_, index) => `order-${index}`),
      getEstimatedCost: async () => {
        if (options.costError) {
          throw options.costError;
        }
        return toBNWei(options.cost ?? "0", 6);
      },
      initializeRebalanceWithTransaction: async (_route: RebalanceRoute, amount: ReturnType<typeof toBNWei>) => {
        if (options.error) {
          throw options.error;
        }
        return options.declineInitialize ? { amount: bnZero } : { amount, transactionHash: "0xdeposit" };
      },
    };
    const bridge = new BinanceStablecoinSwapBridge(
      CHAIN_IDs.AVALANCHE,
      CHAIN_IDs.MAINNET,
      signer,
      signer,
      EvmAddress.from(TOKEN_SYMBOLS_MAP.USDT.addresses[CHAIN_IDs.MAINNET]),
      spyLogger
    );
    Object.assign(bridge, { adapter });
    return {
      bridge,
      signer: baseSignerAddress,
      other: EvmAddress.from(other.address),
      l1Token: EvmAddress.from(TOKEN_SYMBOLS_MAP.USDT.addresses[CHAIN_IDs.MAINNET]),
      l2Token: EvmAddress.from(TOKEN_SYMBOLS_MAP.USDT.addresses[CHAIN_IDs.AVALANCHE]),
    };
  }

  const send = ({ bridge, signer, l1Token, l2Token }: Awaited<ReturnType<typeof makeBridge>>, simMode = false) =>
    bridge.sendL1ToL2Transfer(signer, l1Token, l2Token, toBNWei("100", 6), simMode);

  it("returns the Binance deposit transaction hash", async function () {
    const stack = await makeBridge();

    expect((await send(stack)).hash).to.equal("0xdeposit");
    expect((await send(stack, true)).hash).to.equal(ZERO_BYTES);
  });

  it("declines expensive or capacity-limited transfers without moving funds", async function () {
    const declines: BridgeOptions[] = [
      { cost: "3" }, // Estimated cost above the max fee.
      { pending: 2 }, // Pending-order capacity exhausted.
      { declineInitialize: true }, // The adapter's own preflight declined during initialization.
      { costError: new Error("Binance API unavailable") }, // Preflight dependency failure: nothing submitted yet.
    ];
    for (const options of declines) {
      await expect(send(await makeBridge(options))).to.be.rejectedWith(BridgeTransferDeclinedError);
    }

    // A submission error is not a decline: funds may have moved, so callers must not roll back accounting.
    await expect(send(await makeBridge({ error: new Error("confirmation unavailable") }))).to.be.rejectedWith(
      "confirmation unavailable"
    );
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
