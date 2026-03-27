import { CHAIN_IDs, TOKEN_SYMBOLS_MAP } from "@across-protocol/constants";
import { utils } from "@across-protocol/sdk";
import { BridgeApi } from "../../src/adapter/bridges/BridgeApi";
import { ethers, randomAddress, expect, createSpyLogger, sinon, toBN } from "../utils";
import {
  EvmAddress,
  toBNWei,
  BridgeResponse,
  BRIDGE_API_DESTINATION_TOKENS,
  BRIDGE_API_MINIMUMS,
  BridgeApiClient,
} from "../../src/utils";
import * as sdkUtils from "../../src/utils/SDKUtils";

// Minimal mock for the BridgeApiClient used inside BridgeApi.
class MockBridgeApiClient extends BridgeApiClient {
  public transfersToReturn: BridgeResponse[] = [];
  public escrowAddressToReturn = randomAddress();

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async getAllTransfersInRange(_toAddress: unknown, _fromTimestampMs: number) {
    return this.transfersToReturn;
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async createTransferRouteEscrowAddress(_toAddress: unknown, _l1Symbol: string, _l2Symbol: string) {
    return this.escrowAddressToReturn;
  }

  async filterInitiatedTransfers(
    deposits: BridgeResponse[],
    _fromAddress: Address,
    _eventConfig: EventSearchConfig,
    _originChainId: number,
    _originProvider: Provider
  ): Promise<BridgeResponse[]> {
    return deposits.filter((deposit) => deposit.state !== "payment_processed");
  }
}

// Mock adapter that exposes internals for testing.
class MockBridgeApi extends BridgeApi {
  setMockApi(mockApi: MockBridgeApiClient) {
    this.api = mockApi;
  }

  setL1TokenInfo(tokenInfo: { symbol: string; decimals: number }) {
    this.l1TokenInfo = tokenInfo;
  }
}

const toAddress = (address: string): EvmAddress => EvmAddress.from(address);

describe("Cross Chain Adapter: BridgeApi", async function () {
  let adapter: MockBridgeApi;
  let mockApi: MockBridgeApiClient;
  let monitoredEoa: string;
  let l2TokenAddress: string;
  let searchConfig: utils.EventSearchConfig;

  const hubChainId = CHAIN_IDs.MAINNET;
  const l2ChainId = CHAIN_IDs.TEMPO;
  const l1UsdcAddress = TOKEN_SYMBOLS_MAP.USDC.addresses[hubChainId];
  const logger = createSpyLogger().spyLogger;

  beforeEach(async function () {
    process.env.BRIDGE_API_BASE = "https://mock-bridge-api.test";
    process.env.BRIDGE_API_KEY = "test-api-key";
    process.env.BRIDGE_CUSTOMER_ID = "test-customer-id";

    const [deployer] = await ethers.getSigners();
    monitoredEoa = randomAddress();
    l2TokenAddress = BRIDGE_API_DESTINATION_TOKENS[l2ChainId];

    adapter = new MockBridgeApi(l2ChainId, hubChainId, deployer, deployer, toAddress(l1UsdcAddress), logger);
    adapter.setL1TokenInfo({ symbol: "USDC", decimals: 6 });

    mockApi = new MockBridgeApiClient();
    adapter.setMockApi(mockApi);

    searchConfig = { from: 0, to: 1_000_000 };

    // Stub getTimestampForBlock so queryL1BridgeInitiationEvents doesn't need a real provider.
    sinon.stub(sdkUtils, "getTimestampForBlock").resolves(1_000_000);
    // Stub getTransactionReceipt so queryL1BridgeInitiationEvents doesn't need a real provider.
    sinon.stub(deployer.provider!, "getTransactionReceipt").resolves({ transactionIndex: 0, blockNumber: 1 });
  });

  afterEach(function () {
    sinon.restore();
  });

  describe("constructL1ToL2Txn", function () {
    it("returns an ERC20 transfer to the escrow address", async function () {
      const amount = toBNWei("100", 6);
      const escrowAddress = randomAddress();
      mockApi.escrowAddressToReturn = escrowAddress;

      const result = await adapter.constructL1ToL2Txn(
        toAddress(monitoredEoa),
        toAddress(l1UsdcAddress),
        toAddress(l2TokenAddress),
        amount
      );

      expect(result.args[0]).to.equal(escrowAddress);
      expect(result.args[1]).to.equal(amount);
      expect(result.contract.address).to.equal(l1UsdcAddress);
    });

    it("throws when amount is below minimum", async function () {
      const belowMinimum = BRIDGE_API_MINIMUMS[hubChainId][l2ChainId].sub(1);

      try {
        await adapter.constructL1ToL2Txn(
          toAddress(monitoredEoa),
          toAddress(l1UsdcAddress),
          toAddress(l2TokenAddress),
          belowMinimum
        );
        expect.fail("Should have thrown");
      } catch (e: unknown) {
        expect((e as Error).message).to.include("invalid amount");
      }
    });

    it("throws when l2Token does not match expected destination token", async function () {
      const wrongL2Token = randomAddress();

      try {
        await adapter.constructL1ToL2Txn(
          toAddress(monitoredEoa),
          toAddress(l1UsdcAddress),
          toAddress(wrongL2Token),
          toBNWei("100", 6)
        );
        expect.fail("Should have thrown");
      } catch (e: unknown) {
        expect((e as Error).message).to.include("unsupported l2 token");
      }
    });
  });

  describe("queryL1BridgeInitiationEvents", function () {
    it("returns pending transfers keyed by l2 token address", async function () {
      mockApi.transfersToReturn = [
        makeBridgeResponse({
          state: "funds_received",
          toAddress: monitoredEoa,
          finalAmount: "100.5",
          sourceTxHash: "0xabc123",
        }),
      ];

      const events = await adapter.queryL1BridgeInitiationEvents(
        toAddress(l1UsdcAddress),
        toAddress(monitoredEoa),
        toAddress(monitoredEoa),
        searchConfig
      );

      expect(events[l2TokenAddress]).to.have.lengthOf(1);
      const event = events[l2TokenAddress][0];
      expect(event.txnRef).to.equal("0xabc123");
      // 100.5 * 10^6 = 100_500_000
      expect(event.amount).to.deep.equal(toBN(100_500_000));
      expect(event.logIndex).to.equal(0);
      expect(event.txnIndex).to.equal(0);
    });

    it("does not filter out transfers with awaiting_funds state", async function () {
      mockApi.transfersToReturn = [
        makeBridgeResponse({
          state: "awaiting_funds",
          toAddress: monitoredEoa,
          finalAmount: "100",
          sourceTxHash: undefined,
        }),
        makeBridgeResponse({
          state: "funds_received",
          toAddress: monitoredEoa,
          finalAmount: "50",
          sourceTxHash: "0x1",
        }),
      ];

      const events = await adapter.queryL1BridgeInitiationEvents(
        toAddress(l1UsdcAddress),
        toAddress(monitoredEoa),
        toAddress(monitoredEoa),
        searchConfig
      );

      expect(events[l2TokenAddress]).to.have.lengthOf(2);
      expect(events[l2TokenAddress][0].txnRef).to.equal("0x0");
      expect(events[l2TokenAddress][1].txnRef).to.equal("0x1");
    });

    it("filters out transfers with payment_processed state", async function () {
      mockApi.transfersToReturn = [
        makeBridgeResponse({
          state: "payment_processed",
          toAddress: monitoredEoa,
        }),
      ];

      const events = await adapter.queryL1BridgeInitiationEvents(
        toAddress(l1UsdcAddress),
        toAddress(monitoredEoa),
        toAddress(monitoredEoa),
        searchConfig
      );

      expect(events[l2TokenAddress]).to.have.lengthOf(0);
    });

    it("filters out transfers with non-matching destination address", async function () {
      const differentAddress = randomAddress();
      mockApi.transfersToReturn = [
        makeBridgeResponse({
          state: "funds_received",
          toAddress: differentAddress,
          finalAmount: "100",
          sourceTxHash: "0xdef",
        }),
      ];

      const events = await adapter.queryL1BridgeInitiationEvents(
        toAddress(l1UsdcAddress),
        toAddress(monitoredEoa),
        toAddress(monitoredEoa),
        searchConfig
      );

      expect(events[l2TokenAddress]).to.have.lengthOf(0);
    });

    it("handles multiple valid transfers", async function () {
      mockApi.transfersToReturn = [
        makeBridgeResponse({
          state: "funds_received",
          toAddress: monitoredEoa,
          finalAmount: "10",
          sourceTxHash: "0xa",
        }),
        makeBridgeResponse({
          state: "completed",
          toAddress: monitoredEoa,
          finalAmount: "20",
          sourceTxHash: "0xb",
        }),
      ];

      const events = await adapter.queryL1BridgeInitiationEvents(
        toAddress(l1UsdcAddress),
        toAddress(monitoredEoa),
        toAddress(monitoredEoa),
        searchConfig
      );

      expect(events[l2TokenAddress]).to.have.lengthOf(2);
      expect(events[l2TokenAddress][0].amount).to.deep.equal(toBN(10_000_000));
      expect(events[l2TokenAddress][1].amount).to.deep.equal(toBN(20_000_000));
    });

    it("returns empty array when no transfers exist", async function () {
      mockApi.transfersToReturn = [];

      const events = await adapter.queryL1BridgeInitiationEvents(
        toAddress(l1UsdcAddress),
        toAddress(monitoredEoa),
        toAddress(monitoredEoa),
        searchConfig
      );

      expect(events[l2TokenAddress]).to.have.lengthOf(0);
    });
  });

  describe("queryL2BridgeFinalizationEvents", function () {
    it("always returns empty object", async function () {
      const events = await adapter.queryL2BridgeFinalizationEvents(
        toAddress(l1UsdcAddress),
        toAddress(monitoredEoa),
        toAddress(monitoredEoa),
        searchConfig
      );

      expect(events).to.deep.equal({});
    });
  });
});

function makeBridgeResponse(params: {
  state: string;
  toAddress: string;
  finalAmount?: string;
  sourceTxHash?: string;
}): BridgeResponse {
  return {
    state: params.state,
    created_at: "2024-01-01T00:00:00Z",
    updated_at: "2024-01-01T00:00:00Z",
    destination: {
      payment_rail: "tempo",
      currency: "path_usd",
      to_address: params.toAddress,
    },
    source_deposit_instructions: {
      payment_rail: "ethereum",
      currency: "usdc",
      to_address: randomAddress(),
      from_address: randomAddress(),
    },
    receipt: {
      initial_amount: params.finalAmount ?? "0",
      final_amount: params.finalAmount ?? "0",
      source_tx_hash: params.sourceTxHash ?? "0x0",
    },
  };
}
