import { BinanceStablecoinSwapAdapter, BridgeTransferDeclinedError } from "../src/adapter/bridges";
import { TransactionBroadcastRejectedError, TransactionClient } from "../src/clients";
import {
  BinanceStablecoinSwapAdapter as RebalancerBinanceAdapter,
  getBinanceRebalanceCandidate,
} from "../src/rebalancer/adapters/binance";
import { RebalanceRoute } from "../src/rebalancer/utils/interfaces";
import { CHAIN_IDs, EvmAddress, submitTransaction, TOKEN_SYMBOLS_MAP, ZERO_BYTES } from "../src/utils";
import { createSpyLogger, ethers, expect, sinon, toBNWei } from "./utils";

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
      maxAmount?: string;
      valid?: boolean;
      initialize?: boolean;
      initializeError?: Error;
      submissionError?: Error;
      releaseError?: Error;
      maxPendingOrders?: number;
    } = {}
  ) {
    const [signer, other] = await ethers.getSigners();
    const { spyLogger } = createSpyLogger();
    const baseSignerAddress = EvmAddress.from(signer.address);
    const reservations = new Set<string>();
    const adapter = {
      baseSignerAddress,
      config: {
        maxAmountsToTransfer: options.maxAmount ? { USDT: { [CHAIN_IDs.MAINNET]: toBNWei(options.maxAmount, 6) } } : {},
        maxPendingOrders: { binance: options.maxPendingOrders ?? 2 },
      },
      supportsRoute: () => true,
      getPendingOrders: async () => Array.from({ length: options.pending ?? 0 }, (_, i) => String(i)),
      reservePendingOrderSlot: async (maxPendingOrders: number) => {
        if ((options.pending ?? 0) + reservations.size >= maxPendingOrders) {
          return;
        }
        const reservation = `reservation-${reservations.size}`;
        reservations.add(reservation);
        return reservation;
      },
      releasePendingOrderSlot: async (reservation: string) => {
        if (options.releaseError) {
          throw options.releaseError;
        }
        reservations.delete(reservation);
      },
      getEstimatedCost: async () => toBNWei(options.cost ?? "0", 6),
      getValidatedRebalanceAmount: async (_route: RebalanceRoute, amount: ReturnType<typeof toBNWei>) =>
        options.valid === false ? toBNWei("0", 6) : amount,
      initializeRebalanceWithTransaction: async (
        _route: RebalanceRoute,
        amount: ReturnType<typeof toBNWei>,
        onSubmission?: () => void
      ) => {
        if (options.initializeError) {
          throw options.initializeError;
        }
        if (options.initialize !== false) {
          onSubmission?.();
        }
        if (options.submissionError) {
          throw options.submissionError;
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

    const oneSlot = await makeBridge({ pending: 1 });
    expect(
      await oneSlot.bridge.prepareL1ToL2Transfer(oneSlot.signer, oneSlot.l1Token, oneSlot.l2Token, toBNWei("100", 6))
    ).to.equal(toBNWei("100", 6));
    expect(
      await oneSlot.bridge.prepareL1ToL2Transfer(oneSlot.signer, oneSlot.l1Token, oneSlot.l2Token, toBNWei("50", 6))
    ).to.equal(0);

    const invalid = await makeBridge({ valid: false });
    expect(
      await invalid.bridge.prepareL1ToL2Transfer(invalid.signer, invalid.l1Token, invalid.l2Token, toBNWei("100", 6))
    ).to.equal(0);
  });

  it("reserves pending-order capacity across adapter instances", async function () {
    const [signer] = await ethers.getSigners();
    const account = EvmAddress.from(signer.address);
    const values = new Map<string, string>();
    const sets = new Map<string, Set<string>>();
    let locked = false;
    let failUnlock = false;
    const redis = {
      acquireLock: async () => {
        if (locked) {
          return false;
        }
        return (locked = true);
      },
      releaseLock: async () => {
        locked = false;
        if (failUnlock) {
          failUnlock = false;
          throw new Error("redis unavailable");
        }
        return true;
      },
      get: async (key: string) => values.get(key),
      set: async (key: string, value: string) => {
        values.set(key, value);
        return "OK";
      },
      del: async (key: string) => Number(values.delete(key)),
      sMembers: async (key: string) => [...(sets.get(key) ?? [])],
      sAdd: async (key: string, value: string) => {
        const members = sets.get(key) ?? new Set<string>();
        sets.set(key, members);
        const size = members.size;
        members.add(value);
        return Number(members.size > size);
      },
      sRem: async (key: string, value: string) => Number(sets.get(key)?.delete(value) ?? false),
      moveSetMember: async (source: string, destination: string, value: string) => {
        sets.get(source)?.delete(value);
        const values = sets.get(destination) ?? new Set<string>();
        values.add(value);
        sets.set(destination, values);
        return [1, 1];
      },
    };
    const { spyLogger } = createSpyLogger();
    const makeAdapter = () => {
      const adapter = new RebalancerBinanceAdapter(spyLogger, {} as never, signer, {} as never, {} as never);
      Object.assign(adapter, { _baseSignerAddress: account, _redisCache: redis });
      sinon.stub(adapter, "getPendingOrders").resolves([]);
      return adapter;
    };
    const first = makeAdapter();
    const second = makeAdapter();
    const reservations = await Promise.all([
      first.reservePendingOrderSlot(1, "first"),
      second.reservePendingOrderSlot(1, "second"),
    ]);

    expect(reservations.filter(Boolean)).to.have.length(1);
    await first.releasePendingOrderSlot(reservations.find(Boolean) as string);
    const nextReservation = await second.reservePendingOrderSlot(1, "next");
    expect(nextReservation).to.be.a("string");
    await second.releasePendingOrderSlot(nextReservation as string);
    const duplicate = await first.reservePendingOrderSlot(2, "same-route-and-amount");
    expect(await second.reservePendingOrderSlot(2, "same-route-and-amount")).to.equal(undefined);
    await first.releasePendingOrderSlot(duplicate as string);
    const amount = toBNWei("100", 6);
    const pendingCandidate = getBinanceRebalanceCandidate(route, amount);
    (second.getPendingOrders as sinon.SinonStub).resolves(["pending"]);
    sinon.stub(second as never, "_redisGetOrderDetails").resolves({ ...route, amountToTransfer: amount });
    expect(await second.reservePendingOrderSlot(2, pendingCandidate)).to.equal(undefined);
    failUnlock = true;
    expect(await first.reservePendingOrderSlot(1, "unlock-failure")).to.be.a("string");
  });

  it("rejects a withdrawal recipient other than the signer", async function () {
    const { bridge, other, l1Token, l2Token } = await makeBridge();
    await expect(bridge.prepareL1ToL2Transfer(other, l1Token, l2Token, toBNWei("100", 6))).to.be.rejectedWith(
      "Binance withdrawal recipient must match signer"
    );
  });

  it("distinguishes a repeated-preflight decline from a submission error", async function () {
    const { bridge, signer, l1Token, l2Token } = await makeBridge({ initialize: false });
    const amount = await bridge.prepareL1ToL2Transfer(signer, l1Token, l2Token, toBNWei("100", 6));

    await expect(bridge.sendL1ToL2Transfer(signer, l1Token, l2Token, amount, false)).to.be.rejectedWith(
      BridgeTransferDeclinedError
    );

    const failed = await makeBridge({ initializeError: new Error("deposit address unavailable") });
    const failedAmount = await failed.bridge.prepareL1ToL2Transfer(
      failed.signer,
      failed.l1Token,
      failed.l2Token,
      toBNWei("100", 6)
    );
    await expect(
      failed.bridge.sendL1ToL2Transfer(failed.signer, failed.l1Token, failed.l2Token, failedAmount, false)
    ).to.be.rejectedWith(BridgeTransferDeclinedError);

    const cleanupFailed = await makeBridge({
      initializeError: new Error("deposit address unavailable"),
      releaseError: new Error("redis unavailable"),
    });
    const cleanupFailedAmount = await cleanupFailed.bridge.prepareL1ToL2Transfer(
      cleanupFailed.signer,
      cleanupFailed.l1Token,
      cleanupFailed.l2Token,
      toBNWei("100", 6)
    );
    await expect(
      cleanupFailed.bridge.sendL1ToL2Transfer(
        cleanupFailed.signer,
        cleanupFailed.l1Token,
        cleanupFailed.l2Token,
        cleanupFailedAmount,
        false
      )
    ).to.be.rejectedWith(BridgeTransferDeclinedError);

    const submitted = await makeBridge({
      submissionError: new Error("confirmation unavailable"),
      maxPendingOrders: 1,
    });
    const submittedAmount = await submitted.bridge.prepareL1ToL2Transfer(
      submitted.signer,
      submitted.l1Token,
      submitted.l2Token,
      toBNWei("100", 6)
    );
    await expect(
      submitted.bridge.sendL1ToL2Transfer(
        submitted.signer,
        submitted.l1Token,
        submitted.l2Token,
        submittedAmount,
        false
      )
    ).to.be.rejectedWith("confirmation unavailable");
    expect(
      await submitted.bridge.prepareL1ToL2Transfer(
        submitted.signer,
        submitted.l1Token,
        submitted.l2Token,
        toBNWei("100", 6)
      )
    ).to.equal(toBNWei("100", 6));

    const rejected = await makeBridge({
      submissionError: new TransactionBroadcastRejectedError(new Error("insufficient funds")),
    });
    const rejectedAmount = await rejected.bridge.prepareL1ToL2Transfer(
      rejected.signer,
      rejected.l1Token,
      rejected.l2Token,
      toBNWei("100", 6)
    );
    await expect(
      rejected.bridge.sendL1ToL2Transfer(rejected.signer, rejected.l1Token, rejected.l2Token, rejectedAmount, false)
    ).to.be.rejectedWith(BridgeTransferDeclinedError);
  });

  it("marks submission at the broadcast boundary", async function () {
    const transaction = { contract: { address: ZERO_BYTES }, method: "transfer", args: [], chainId: 1 } as never;
    let submissionStarted = false;
    const failedSimulation = {
      simulate: async () => [{ transaction, succeed: false, reason: "reverted" }],
      submit: async () => [],
    } as never;

    await expect(
      submitTransaction(transaction, failedSimulation, () => {
        submissionStarted = true;
      })
    ).to.be.rejectedWith("Failed to simulate");
    expect(submissionStarted).to.be.false;

    const { spyLogger } = createSpyLogger();
    const preBroadcastFailure = {
      ...transaction,
      contract: { signer: { getAddress: async () => Promise.reject(new Error("signer unavailable")) } },
      onSubmission: () => {
        submissionStarted = true;
      },
    } as never;
    await expect(new TransactionClient(spyLogger).submit(1, [preBroadcastFailure])).to.be.rejectedWith(
      "signer unavailable"
    );
    expect(submissionStarted).to.be.false;

    const failedSubmission = {
      simulate: async () => [{ transaction, succeed: true }],
      submit: async (_chainId: number, [transaction]: { onSubmission?: () => void | Promise<void> }[]) => {
        await transaction.onSubmission?.();
        return [];
      },
    } as never;
    await expect(
      submitTransaction(transaction, failedSubmission, () => {
        submissionStarted = true;
      })
    ).to.be.rejectedWith("failed to submit onchain");
    expect(submissionStarted).to.be.true;
  });

  it("leaves bridge-event accounting to Redis-backed pending rebalances", async function () {
    const { bridge, signer, l1Token } = await makeBridge();
    const eventConfig = { from: 0, to: 0, maxBlockLookBack: 1 };

    expect(await bridge.queryL1BridgeInitiationEvents(l1Token, signer, signer, eventConfig)).to.deep.equal({});
    expect(await bridge.queryL2BridgeFinalizationEvents(l1Token, signer, signer, eventConfig)).to.deep.equal({});
  });
});
