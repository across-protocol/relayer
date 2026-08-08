import { BinanceStablecoinSwapBridge } from "../src/adapter/bridges";
import { RebalanceRoute } from "../src/rebalancer/utils/interfaces";
import { CHAIN_IDs, EvmAddress, TOKEN_SYMBOLS_MAP, ZERO_BYTES, bnZero } from "../src/utils";
import { createSpyLogger, ethers, expect, toBNWei } from "./utils";

const SUPPORTED_ROUTE = {
  sourceChain: CHAIN_IDs.MAINNET,
  sourceToken: "USDT",
  destinationChain: CHAIN_IDs.AVALANCHE,
  destinationToken: "USDT",
  adapter: "binance",
};

describe("BinanceStablecoinSwapBridge", function () {
  type BridgeOptions = {
    pending?: number;
    cost?: string;
    costError?: Error;
    declineInitialize?: boolean;
    error?: Error;
    maxAmount?: string;
  };

  async function makeBridge(options: BridgeOptions = {}) {
    const [signer, other] = await ethers.getSigners();
    const { spyLogger } = createSpyLogger();
    const baseSignerAddress = EvmAddress.from(signer.address);
    const adapter = {
      baseSignerAddress,
      supportsRoute: (route: RebalanceRoute) =>
        Object.entries(SUPPORTED_ROUTE).every(([key, value]) => route[key as keyof RebalanceRoute] === value),
      config: {
        maxAmountsToTransfer: options.maxAmount ? { USDT: { [CHAIN_IDs.MAINNET]: toBNWei(options.maxAmount, 6) } } : {},
        maxPendingOrders: {},
      },
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
      spyLogger,
      Promise.resolve(adapter as never)
    );
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

  it("rejects one-shot on expensive, capacity-limited, or failed transfers", async function () {
    // Every Binance-side failure rejects the single initiation promise with no funds moved - the same contract
    // callers already have with a bridge transaction that failed to mine.
    const rejections: [BridgeOptions, string][] = [
      [{ maxAmount: "5" }, "exceeds the configured Binance maximum"], // Fail fast instead of resizing the transfer.
      [{ cost: "3" }, "cost exceeds the maximum fee"],
      [{ pending: 2 }, "Too many pending Binance orders"],
      [{ declineInitialize: true }, "declined transfer during initialization"],
      [{ costError: new Error("Binance API unavailable") }, "Binance API unavailable"],
      [{ error: new Error("confirmation unavailable") }, "confirmation unavailable"],
    ];
    for (const [options, message] of rejections) {
      await expect(send(await makeBridge(options))).to.be.rejectedWith(message);
    }
  });

  it("rejects routes the adapter does not support", async function () {
    const { bridge, signer, l1Token } = await makeBridge();
    const usdcL2Token = EvmAddress.from(TOKEN_SYMBOLS_MAP.USDC.addresses[CHAIN_IDs.AVALANCHE]);
    await expect(bridge.sendL1ToL2Transfer(signer, l1Token, usdcL2Token, toBNWei("100", 6), false)).to.be.rejectedWith(
      "does not support this route"
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
