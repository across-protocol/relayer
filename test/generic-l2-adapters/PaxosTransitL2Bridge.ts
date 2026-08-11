import { CHAIN_IDs, TOKEN_SYMBOLS_MAP } from "@across-protocol/constants";
import { ethers } from "hardhat";
import { PaxosTransitL2Bridge } from "../../src/adapter/l2Bridges/PaxosTransitL2Bridge";
import { expect, sinon, toBNWei, randomAddress } from "../utils";
import {
  EvmAddress,
  isDefined,
  PAXOS_TRANSIT_DESTINATION_TOKENS,
  PaxosTransitClient,
  PaxosTransitOrder,
  PaxosTransitOrderQuoteResponse,
  getPaxosTransitStationAddress,
} from "../../src/utils";
import * as contractUtils from "../../src/utils/ContractUtils";
import * as eventUtils from "../../src/utils/EventUtils";

class MockPaxosTransitClient extends PaxosTransitClient {
  public orderQuote: PaxosTransitOrderQuoteResponse = {
    transaction: {
      to: "0x1111111111111111111111111111111111111111",
      data: "0xdeadbeef",
      value: "0",
    },
  };
  public orders: PaxosTransitOrder[] = [];
  public listOrdersError: Error | undefined;

  constructor() {
    super("https://mock-paxos.test", "test-api-key");
  }

  async getAuthorization() {
    return {
      spenderAddress: "0x2222222222222222222222222222222222222222",
      alreadyApproved: true,
      methods: [],
    };
  }

  async getOrderQuote() {
    return this.orderQuote;
  }

  async listOrders(params: { userAddress: string; filter?: string; pageSize?: number; pageToken?: string }) {
    if (isDefined(this.listOrdersError)) {
      throw this.listOrdersError;
    }
    const { filter } = params;
    const filteredOrders = isDefined(filter)
      ? this.orders.filter((order) => {
          const clauses = filter.split(" OR ").map((clause) => clause.trim());
          return clauses.some((clause) => {
            const [field, value] = clause.split("=");
            return field === "status" && order.status === value;
          });
        })
      : this.orders;
    return {
      orders: filteredOrders,
      nextPageToken: null,
    };
  }
}

class MockPaxosTransitL2Bridge extends PaxosTransitL2Bridge {
  setMockClient(client: MockPaxosTransitClient) {
    this.client = client;
  }
}

const toAddress = (address: string): EvmAddress => EvmAddress.from(address);

describe("Cross Chain Adapter: PaxosTransitL2Bridge", function () {
  let adapter: MockPaxosTransitL2Bridge;
  let mockClient: MockPaxosTransitClient;
  let relayerAddress: string;

  const hubChainId = CHAIN_IDs.MAINNET;
  const l2ChainId = CHAIN_IDs.ROBINHOOD;
  const l1UsdcAddress = TOKEN_SYMBOLS_MAP.USDC.addresses[hubChainId];
  const l2UsdgAddress = PAXOS_TRANSIT_DESTINATION_TOKENS[l2ChainId][l1UsdcAddress];
  const searchConfig = { from: 0, to: 1_000_000 };

  beforeEach(async function () {
    process.env.PAXOS_API_KEY = "test-api-key";
    process.env.PAXOS_TRANSIT_STATION_1 = "0x2222222222222222222222222222222222222222";
    process.env.PAXOS_TRANSIT_STATION_4663 = "0x3333333333333333333333333333333333333333";

    sinon.stub(contractUtils, "getSpokePoolAddress").returns(EvmAddress.from(randomAddress()));
    sinon.stub(contractUtils, "getHubPoolAddress").returns(EvmAddress.from(randomAddress()));

    const [deployer] = await ethers.getSigners();
    relayerAddress = await deployer.getAddress();
    adapter = new MockPaxosTransitL2Bridge(l2ChainId, hubChainId, deployer, deployer, toAddress(l1UsdcAddress));
    mockClient = new MockPaxosTransitClient();
    mockClient.listOrdersError = undefined;
    adapter.setMockClient(mockClient);
  });

  afterEach(function () {
    sinon.restore();
  });

  function buildL2ToL1Order(overrides: Partial<PaxosTransitOrder>): PaxosTransitOrder {
    return {
      id: "0xorder1",
      offerAsset: l2UsdgAddress,
      wantAsset: l1UsdcAddress,
      offerAmount: "10000000",
      amountDue: "9975000",
      remainingAmountDue: "9975000",
      receiver: relayerAddress,
      sourceChainId: l2ChainId,
      destinationChainId: hubChainId,
      status: "PENDING_BRIDGE",
      ...overrides,
    };
  }

  it("returns outstanding RH USDG withdrawal amount from Paxos API", async function () {
    mockClient.orders = [
      buildL2ToL1Order({ id: "0xrh-pending", remainingAmountDue: "5000000" }),
      buildL2ToL1Order({ id: "0xprocessed", status: "PROCESSED", remainingAmountDue: "0" }),
      buildL2ToL1Order({
        id: "0xl1-to-l2",
        offerAsset: l1UsdcAddress,
        wantAsset: l2UsdgAddress,
        sourceChainId: hubChainId,
        destinationChainId: l2ChainId,
      }),
    ];
    const listOrdersSpy = sinon.spy(mockClient, "listOrders");

    const amount = await adapter.getL2PendingWithdrawalAmount(
      searchConfig,
      searchConfig,
      toAddress(relayerAddress),
      toAddress(l2UsdgAddress)
    );

    expect(amount).to.equal(toBNWei("5", 6));
    expect(listOrdersSpy.callCount).to.equal(1);
    expect(listOrdersSpy.firstCall.args[0].filter).to.equal("status=PROCESSING OR status=PENDING_BRIDGE");
  });

  it("falls back to on-chain transfer events when Paxos API fails", async function () {
    mockClient.listOrdersError = new Error("Paxos API unavailable");
    const transferAmount = toBNWei("12.5", 6);
    const paginatedEventQueryStub = sinon.stub(eventUtils, "paginatedEventQuery").resolves([
      {
        blockNumber: 1,
        transactionIndex: 0,
        logIndex: 0,
        args: { value: transferAmount },
      },
    ]);

    const amount = await adapter.getL2PendingWithdrawalAmount(
      searchConfig,
      searchConfig,
      toAddress(relayerAddress),
      toAddress(l2UsdgAddress)
    );

    expect(amount).to.equal(transferAmount);
    expect(paginatedEventQueryStub.calledOnce).to.be.true;
    const transferFilter = paginatedEventQueryStub.firstCall.args[1];
    expect(transferFilter.topics[1]).to.equal(ethers.utils.hexZeroPad(relayerAddress.toLowerCase(), 32));
    expect(transferFilter.topics[2]).to.equal(
      ethers.utils.hexZeroPad(getPaxosTransitStationAddress(l2ChainId).toLowerCase(), 32)
    );
  });
});
