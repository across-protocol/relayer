import { CHAIN_IDs, TOKEN_SYMBOLS_MAP } from "@across-protocol/constants";
import { ethers, expect, toBNWei, Contract } from "../utils";
import { BaseChainAdapter } from "../../src/adapter";
import { BaseBridgeAdapter, BridgeEvents, BridgeTransactionDetails } from "../../src/adapter/bridges/BaseBridgeAdapter";
import { BaseL2BridgeAdapter } from "../../src/adapter/l2Bridges/BaseL2BridgeAdapter";
import { PendingBridgeAdapterName, PendingBridgeRedisReader } from "../../src/rebalancer/utils/PendingBridgeRedis";
import { Address, BigNumber, EvmAddress, EventSearchConfig, Signer } from "../../src/utils";

describe("BaseChainAdapter split bridge tracking", function () {
  it("ignores rebalancer-owned OFT bridge transfers when computing outstanding amounts", async function () {
    const outstandingTransfers = await getOutstandingTransfersForTrackedBridge("oft", "USDT");
    const l1Token = TOKEN_SYMBOLS_MAP.USDT.addresses[CHAIN_IDs.MAINNET];
    const l2Token = TOKEN_SYMBOLS_MAP.USDT.addresses[CHAIN_IDs.ARBITRUM];
    expect(outstandingTransfers[MONITORED_ADDRESS][l1Token][l2Token].totalAmount).to.equal(toBNWei("2", 6));
    expect(outstandingTransfers[MONITORED_ADDRESS][l1Token][l2Token].depositTxHashes).to.deep.equal(["tracked"]);
  });

  it("ignores rebalancer-owned CCTP bridge transfers when computing outstanding amounts", async function () {
    const outstandingTransfers = await getOutstandingTransfersForTrackedBridge("cctp", "USDC");
    const l1Token = TOKEN_SYMBOLS_MAP.USDC.addresses[CHAIN_IDs.MAINNET];
    const l2Token = TOKEN_SYMBOLS_MAP.USDC.addresses[CHAIN_IDs.BASE];
    expect(outstandingTransfers[MONITORED_ADDRESS][l1Token][l2Token].totalAmount).to.equal(toBNWei("2", 6));
    expect(outstandingTransfers[MONITORED_ADDRESS][l1Token][l2Token].depositTxHashes).to.deep.equal(["tracked"]);
  });
});

const MONITORED_ADDRESS = "0x1000000000000000000000000000000000000001";

async function getOutstandingTransfersForTrackedBridge(adapterName: PendingBridgeAdapterName, tokenSymbol: "USDT" | "USDC") {
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
    tokenSymbol,
    {
      [l2Token]: [
        makeBridgeEvent(toBNWei("1", 6), "ignored"),
        makeBridgeEvent(toBNWei("2", 6), "tracked"),
      ],
    }
  );
  const pendingBridgeRedisReader = {
    getPendingBridgeAmountsForRoute: async () => [toBNWei("1", 6)],
  } as unknown as PendingBridgeRedisReader;
  const adapter = new BaseChainAdapter(
    {
      [CHAIN_IDs.MAINNET]: makeSpokePoolClient(CHAIN_IDs.MAINNET),
      [l2ChainId]: makeSpokePoolClient(l2ChainId),
    } as any,
    l2ChainId,
    CHAIN_IDs.MAINNET,
    [EvmAddress.from(MONITORED_ADDRESS)],
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
  return {
    amount,
    txnRef,
    blockNumber: 1,
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
    private readonly tokenSymbol: string,
    private readonly initiationEvents: BridgeEvents
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

  async queryL2BridgeFinalizationEvents(): Promise<BridgeEvents> {
    return {};
  }

  override getRebalancerPendingBridgeAdapterName(): PendingBridgeAdapterName {
    return this.adapterName;
  }

  override getRebalancerPendingBridgeTokenSymbol(): string {
    return this.tokenSymbol;
  }
}

class NoopL2Bridge extends BaseL2BridgeAdapter {
  constructor(l2ChainId: number, hubChainId: number, signer: Signer, l1Token: EvmAddress) {
    super(l2ChainId, hubChainId, signer, signer, l1Token);
  }

  async constructWithdrawToL1Txns(): Promise<never[]> {
    return [];
  }

  async getL2PendingWithdrawalAmount(
    _l2EventSearchConfig: EventSearchConfig,
    _l1EventSearchConfig: EventSearchConfig,
    _fromAddress: Address,
    _l2Token: Address
  ): Promise<BigNumber> {
    return BigNumber.from(0);
  }
}

const TEST_LOGGER = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
} as any;
