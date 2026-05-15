import { CHAIN_IDs, TOKEN_SYMBOLS_MAP } from "@across-protocol/constants";
import * as winston from "winston";
import { ethers, expect, toBNWei, Contract } from "../utils";
import { SpokePoolClient } from "../../src/clients";
import { BaseChainAdapter } from "../../src/adapter";
import {
  BaseBridgeAdapter,
  BridgeEvent,
  BridgeEvents,
  BridgeTransactionDetails,
} from "../../src/adapter/bridges/BaseBridgeAdapter";
import { BaseL2BridgeAdapter } from "../../src/adapter/l2Bridges/BaseL2BridgeAdapter";
import { PendingBridgeAdapterName, CctpOftReadOnlyClient } from "../../src/rebalancer/clients/CctpOftReadOnlyClient";
import { BigNumber, EvmAddress, Signer } from "../../src/utils";

describe("BaseChainAdapter split bridge tracking", function () {
  it("ignores rebalancer-owned OFT bridge transfers when computing outstanding amounts", async function () {
    const outstandingTransfers = await getOutstandingTransfersForTrackedBridge("oft", "USDT", [
      makeBridgeEvent(toBNWei("1", 6), "ignored"),
      makeBridgeEvent(toBNWei("2", 6), "tracked"),
    ]);
    const l1Token = TOKEN_SYMBOLS_MAP.USDT.addresses[CHAIN_IDs.MAINNET];
    const l2Token = TOKEN_SYMBOLS_MAP.USDT.addresses[CHAIN_IDs.ARBITRUM];
    expect(outstandingTransfers[MONITORED_ADDRESS][l1Token][l2Token].totalAmount).to.equal(toBNWei("2", 6));
    expect(outstandingTransfers[MONITORED_ADDRESS][l1Token][l2Token].depositTxHashes).to.deep.equal(["tracked"]);
  });

  it("ignores rebalancer-owned CCTP bridge transfers when computing outstanding amounts", async function () {
    const outstandingTransfers = await getOutstandingTransfersForTrackedBridge("cctp", "USDC", [
      makeBridgeEvent(toBNWei("1", 6), "ignored"),
      makeBridgeEvent(toBNWei("2", 6), "tracked"),
    ]);
    const l1Token = TOKEN_SYMBOLS_MAP.USDC.addresses[CHAIN_IDs.MAINNET];
    const l2Token = TOKEN_SYMBOLS_MAP.USDC.addresses[CHAIN_IDs.BASE];
    expect(outstandingTransfers[MONITORED_ADDRESS][l1Token][l2Token].totalAmount).to.equal(toBNWei("2", 6));
    expect(outstandingTransfers[MONITORED_ADDRESS][l1Token][l2Token].depositTxHashes).to.deep.equal(["tracked"]);
  });

  it("ignores only the matching txnRef when two transfers share the same amount", async function () {
    const sharedAmount = toBNWei("1", 6);
    const outstandingTransfers = await getOutstandingTransfersForTrackedBridge("oft", "USDT", [
      makeBridgeEvent(sharedAmount, "ignored"),
      makeBridgeEvent(sharedAmount, "tracked"),
    ]);
    const l1Token = TOKEN_SYMBOLS_MAP.USDT.addresses[CHAIN_IDs.MAINNET];
    const l2Token = TOKEN_SYMBOLS_MAP.USDT.addresses[CHAIN_IDs.ARBITRUM];
    expect(outstandingTransfers[MONITORED_ADDRESS][l1Token][l2Token].totalAmount).to.equal(sharedAmount);
    expect(outstandingTransfers[MONITORED_ADDRESS][l1Token][l2Token].depositTxHashes).to.deep.equal(["tracked"]);
  });

  it("finalized events reduce tracked outstanding amounts via net-amount matching", async function () {
    const trackedAmount = toBNWei("2", 6);
    const finalizedAmount = toBNWei("1", 6);
    const outstandingTransfers = await getOutstandingTransfersForTrackedBridge(
      "oft",
      "USDT",
      [makeBridgeEvent(finalizedAmount, "ignored"), makeBridgeEvent(trackedAmount, "tracked")],
      [makeBridgeEvent(finalizedAmount, "ignored-finalized")]
    );
    const l1Token = TOKEN_SYMBOLS_MAP.USDT.addresses[CHAIN_IDs.MAINNET];
    const l2Token = TOKEN_SYMBOLS_MAP.USDT.addresses[CHAIN_IDs.ARBITRUM];
    // Net-amount matching: totalDeposited (only "tracked" = 2000000) - totalFinalized (1000000) = 1000000
    const expectedOutstanding = trackedAmount.sub(finalizedAmount);
    expect(outstandingTransfers[MONITORED_ADDRESS][l1Token][l2Token].totalAmount).to.equal(expectedOutstanding);
    expect(outstandingTransfers[MONITORED_ADDRESS][l1Token][l2Token].depositTxHashes).to.deep.equal(["tracked"]);
  });
});

const MONITORED_ADDRESS = "0x1000000000000000000000000000000000000001";

async function getOutstandingTransfersForTrackedBridge(
  adapterName: PendingBridgeAdapterName,
  tokenSymbol: "USDT" | "USDC",
  initiationEvents: ReturnType<typeof makeBridgeEvent>[],
  finalizedEvents: ReturnType<typeof makeBridgeEvent>[] = []
) {
  const [signer] = await ethers.getSigners();
  const l2ChainId = adapterName === "oft" ? CHAIN_IDs.ARBITRUM : CHAIN_IDs.BASE;
  const l1Token = EvmAddress.from(TOKEN_SYMBOLS_MAP[tokenSymbol].addresses[CHAIN_IDs.MAINNET]);
  const l2Token = TOKEN_SYMBOLS_MAP[tokenSymbol].addresses[l2ChainId];
  const bridge = new MockTrackedBridge(
    l2ChainId,
    CHAIN_IDs.MAINNET,
    signer,
    l1Token,
    adapterName,
    { [l2Token]: initiationEvents },
    { [l2Token]: finalizedEvents }
  );
  const pendingBridgeRedisReader = {
    getPendingBridgeTxnRefsForRoute: async () => new Set(["ignored"]),
  } as unknown as CctpOftReadOnlyClient;
  const adapter = new BaseChainAdapter(
    {
      [CHAIN_IDs.MAINNET]: makeSpokePoolClient(CHAIN_IDs.MAINNET),
      [l2ChainId]: makeSpokePoolClient(l2ChainId),
    } as unknown as { [chainId: number]: SpokePoolClient },
    l2ChainId,
    CHAIN_IDs.MAINNET,
    { [l1Token.toNative()]: [EvmAddress.from(MONITORED_ADDRESS)] },
    TEST_LOGGER,
    [tokenSymbol],
    { [l1Token.toNative()]: bridge },
    { [l1Token.toNative()]: new NoopL2Bridge(l2ChainId, CHAIN_IDs.MAINNET, signer, l1Token) },
    1,
    pendingBridgeRedisReader
  );
  return adapter.getOutstandingCrossChainTransfers([l1Token]);
}

function makeSpokePoolClient(chainId: number) {
  return {
    chainId,
    latestHeightSearched: 100,
    eventSearchConfig: { from: 1, maxLookBack: 100 },
  };
}

function makeBridgeEvent(amount: BigNumber, txnRef: string) {
  return <BridgeEvent>{
    amount,
    txnRef,
    blockNumber: 1,
    txnIndex: 0,
    transactionIndex: 0,
    logIndex: 0,
  };
}

class MockTrackedBridge extends BaseBridgeAdapter {
  constructor(
    l2ChainId: number,
    l1ChainId: number,
    signer: Signer,
    private readonly l1Token: EvmAddress,
    private readonly adapterName: PendingBridgeAdapterName,
    private readonly initiationEvents: BridgeEvents,
    private readonly finalizedEvents: BridgeEvents
  ) {
    super(l2ChainId, l1ChainId, signer, []);
    this.l1Bridge = new Contract(EvmAddress.from(MONITORED_ADDRESS).toNative(), [], signer);
    this.l2Bridge = new Contract(EvmAddress.from(MONITORED_ADDRESS).toNative(), [], signer);
  }

  async constructL1ToL2Txn(): Promise<BridgeTransactionDetails> {
    throw new Error("not implemented in test");
  }

  async queryL1BridgeInitiationEvents(l1Token: EvmAddress): Promise<BridgeEvents> {
    if (!l1Token.eq(this.l1Token)) {
      return {};
    }
    return this.initiationEvents;
  }

  async queryL2BridgeFinalizationEvents(l1Token: EvmAddress): Promise<BridgeEvents> {
    if (!l1Token.eq(this.l1Token)) {
      return {};
    }
    return this.finalizedEvents;
  }

  override getRebalancerPendingBridgeAdapterName(): PendingBridgeAdapterName {
    return this.adapterName;
  }
}

class NoopL2Bridge extends BaseL2BridgeAdapter {
  constructor(l2ChainId: number, hubChainId: number, signer: Signer, l1Token: EvmAddress) {
    super(l2ChainId, hubChainId, signer, signer, l1Token);
  }

  async constructWithdrawToL1Txns(): Promise<never[]> {
    return [];
  }

  async getL2PendingWithdrawalAmount(): Promise<BigNumber> {
    return BigNumber.from(0);
  }
}

const TEST_LOGGER = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
} as unknown as winston.Logger;
