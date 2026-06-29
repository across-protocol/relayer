import { CHAIN_IDs, TOKEN_SYMBOLS_MAP } from "@across-protocol/constants";
import { ethers } from "hardhat";
import { BigNumber } from "ethers";
import { PaxosTransitBridge } from "../../src/adapter/bridges/PaxosTransitBridge";
import { expect, createSpyLogger, sinon, toBNWei, randomAddress, assert } from "../utils";
import {
  EvmAddress,
  isDefined,
  PAXOS_TRANSIT_DESTINATION_TOKENS,
  PAXOS_TRANSIT_MINIMUMS,
  PaxosTransitClient,
  PaxosTransitOrder,
  PaxosTransitOrderQuoteResponse,
  getPaxosTransitStationAddress,
  getPaxosTransitBoringVaultAddress,
  getPaxosTransitL1ReceiveAsset,
  getPaxosTransitQuotedReceiveRedisKey,
  ConvertDecimals,
  getPaxosTransitInitiationAmountForOutstandingTransfers,
  isPaxosTransitOrderOutstanding,
  paxosTransitOrderMatchesRoute,
} from "../../src/utils";
import * as contractUtils from "../../src/utils/ContractUtils";
import * as eventUtils from "../../src/utils/EventUtils";
import * as redisCache from "../../src/cache/Redis";

class MockPaxosTransitClient extends PaxosTransitClient {
  public authorizationResponse: PaxosTransitClient["getAuthorization"] extends (...args: infer _) => infer R
    ? Awaited<R>
    : never = {
    spenderAddress: "0x2222222222222222222222222222222222222222",
    alreadyApproved: true,
    methods: [],
  };
  public orderQuote: PaxosTransitOrderQuoteResponse = {
    transaction: {
      to: "0x1111111111111111111111111111111111111111",
      data: "0xdeadbeef",
      value: "0",
    },
    amountOut: "9975000",
    protocolFee: "25000",
    integratorFee: "0",
    totalFees: "25000",
  };
  public orders: PaxosTransitOrder[] = [];

  constructor() {
    super("https://mock-paxos.test", "test-api-key");
  }

  async getAuthorization() {
    return this.authorizationResponse;
  }

  async getOrderQuote() {
    return this.orderQuote;
  }

  async listOrders(params: { userAddress: string; filter?: string; pageSize?: number; pageToken?: string }) {
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

class MockPaxosTransitBridge extends PaxosTransitBridge {
  setMockClient(client: MockPaxosTransitClient) {
    this.client = client;
  }
}

const toAddress = (address: string): EvmAddress => EvmAddress.from(address);

describe("Cross Chain Adapter: PaxosTransitBridge", function () {
  let adapter: MockPaxosTransitBridge;
  let mockClient: MockPaxosTransitClient;

  const hubChainId = CHAIN_IDs.MAINNET;
  const l2ChainId = CHAIN_IDs.ROBINHOOD;
  const l1UsdcAddress = TOKEN_SYMBOLS_MAP.USDC.addresses[hubChainId];
  const l2UsdgAddress = PAXOS_TRANSIT_DESTINATION_TOKENS[l2ChainId][l1UsdcAddress];
  const logger = createSpyLogger().spyLogger;

  beforeEach(async function () {
    process.env.PAXOS_API_KEY = "test-api-key";
    process.env.PAXOS_TRANSIT_STATION_1 = "0x2222222222222222222222222222222222222222";
    process.env.PAXOS_TRANSIT_STATION_4663 = "0x3333333333333333333333333333333333333333";

    sinon.stub(contractUtils, "getSpokePoolAddress").returns(EvmAddress.from(randomAddress()));
    sinon.stub(contractUtils, "getHubPoolAddress").returns(EvmAddress.from(randomAddress()));

    const [deployer] = await ethers.getSigners();
    adapter = new MockPaxosTransitBridge(l2ChainId, hubChainId, deployer, deployer, toAddress(l1UsdcAddress), logger);
    mockClient = new MockPaxosTransitClient();
    adapter.setMockClient(mockClient);
  });

  afterEach(function () {
    sinon.restore();
  });

  describe("constructL1ToL2Txn", function () {
    it("returns raw submitOrder calldata from the Paxos API", async function () {
      const amount = toBNWei("100", 6);
      const result = await adapter.constructL1ToL2Txn(
        toAddress(await adapter["l1Signer"].getAddress()),
        toAddress(l1UsdcAddress),
        toAddress(l2UsdgAddress),
        amount
      );

      expect(result.method).to.equal("");
      expect(result.args[0]).to.equal("0xdeadbeef");
      expect(result.contract.address).to.equal("0x1111111111111111111111111111111111111111");
      expect(result.expectedDestinationReceiveAmount).to.deep.equal(BigNumber.from("9975000"));
    });

    it("throws when amount is below minimum", async function () {
      const belowMinimum = PAXOS_TRANSIT_MINIMUMS[hubChainId][l2ChainId].sub(1);

      try {
        await adapter.constructL1ToL2Txn(
          toAddress(await adapter["l1Signer"].getAddress()),
          toAddress(l1UsdcAddress),
          toAddress(l2UsdgAddress),
          belowMinimum
        );
        expect.fail("Should have thrown");
      } catch (e: unknown) {
        expect((e as Error).message).to.include("invalid amount");
      }
    });

    it("uses ContractAddresses default when env override is unset", function () {
      delete process.env.PAXOS_TRANSIT_STATION_1;
      delete process.env.PAXOS_TRANSIT_STATION_4663;
      delete process.env.PAXOS_TRANSIT_BORING_VAULT_1;
      delete process.env.PAXOS_TRANSIT_BORING_VAULT_4663;

      expect(getPaxosTransitStationAddress(CHAIN_IDs.MAINNET)).to.equal("0x49AAA987b1a7e9E4AE091dcD8332c39F322D7d28");
      expect(getPaxosTransitStationAddress(CHAIN_IDs.ROBINHOOD)).to.equal("0x49AAA987b1a7e9E4AE091dcD8332c39F322D7d28");
      expect(getPaxosTransitBoringVaultAddress(CHAIN_IDs.MAINNET)).to.equal(
        "0x91fe06c6e9f97e7de4580a280e03046155f8e1e3"
      );
      expect(getPaxosTransitBoringVaultAddress(CHAIN_IDs.ROBINHOOD)).to.equal(
        "0x91fe06c6e9f97e7de4580a280e03046155f8e1e3"
      );
    });

    it("prefers env override over ContractAddresses default", function () {
      process.env.PAXOS_TRANSIT_STATION_1 = "0x2222222222222222222222222222222222222222";
      expect(getPaxosTransitStationAddress(CHAIN_IDs.MAINNET)).to.equal("0x2222222222222222222222222222222222222222");
    });

    it("maps Robinhood USDG registry token to mainnet USDC Paxos receive asset", function () {
      const mainnetUsdg = EvmAddress.from(TOKEN_SYMBOLS_MAP.USDG.addresses[CHAIN_IDs.MAINNET]);
      expect(getPaxosTransitL1ReceiveAsset(CHAIN_IDs.ROBINHOOD, mainnetUsdg)).to.equal(
        TOKEN_SYMBOLS_MAP.USDC.addresses[CHAIN_IDs.MAINNET]
      );
    });

    it("throws when l2Token does not match expected destination token", async function () {
      try {
        await adapter.constructL1ToL2Txn(
          toAddress(await adapter["l1Signer"].getAddress()),
          toAddress(l1UsdcAddress),
          toAddress("0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"),
          toBNWei("100", 6)
        );
        expect.fail("Should have thrown");
      } catch (e: unknown) {
        expect((e as Error).message).to.include("unsupported l2 token");
      }
    });

    it("submits erc20_approve when available, even if permit is also offered", async function () {
      mockClient.authorizationResponse = {
        spenderAddress: "0x2222222222222222222222222222222222222222",
        alreadyApproved: false,
        methods: [
          {
            type: "eip2612_permit",
            permitData: {
              domain: {
                name: "USD Coin",
                version: "2",
                chainId: CHAIN_IDs.MAINNET,
                verifyingContract: TOKEN_SYMBOLS_MAP.USDC.addresses[CHAIN_IDs.MAINNET],
              },
              types: {
                Permit: [
                  { name: "owner", type: "address" },
                  { name: "spender", type: "address" },
                  { name: "value", type: "uint256" },
                  { name: "nonce", type: "uint256" },
                  { name: "deadline", type: "uint256" },
                ],
              },
              value: {
                owner: "0x0000000000000000000000000000000000000001",
                spender: "0x0000000000000000000000000000000000000002",
                value: "1000000",
                nonce: "0",
                deadline: "9999999999",
              },
              deadline: "9999999999",
            },
          },
          {
            type: "erc20_approve",
            transaction: { encoded: "0xapprove" },
          },
        ],
      };

      const sendTransaction = sinon.stub(adapter["l1Signer"], "sendTransaction").resolves({
        hash: "0xabc",
      } as never);
      const l1Provider = adapter["l1Signer"].provider;
      assert(isDefined(l1Provider), "l1Signer must have a provider");
      const waitForTransaction = sinon.stub(l1Provider, "waitForTransaction").resolves({} as never);

      const getOrderQuoteSpy = sinon.spy(mockClient, "getOrderQuote");
      const amount = toBNWei("100", 6);
      await adapter.constructL1ToL2Txn(
        toAddress(await adapter["l1Signer"].getAddress()),
        toAddress(l1UsdcAddress),
        toAddress(l2UsdgAddress),
        amount
      );

      expect(sendTransaction.calledOnce).to.be.true;
      expect(waitForTransaction.calledOnceWith("0xabc")).to.be.true;
      expect(getOrderQuoteSpy.calledOnce).to.be.true;
      expect(getOrderQuoteSpy.firstCall.args[0].permitSignature).to.be.undefined;
    });

    it("signs an EIP-2612 permit when approval is not offered", async function () {
      mockClient.authorizationResponse = {
        spenderAddress: "0x2222222222222222222222222222222222222222",
        alreadyApproved: false,
        methods: [
          {
            type: "eip2612_permit",
            permitData: {
              domain: {
                name: "USD Coin",
                version: "2",
                chainId: CHAIN_IDs.MAINNET,
                verifyingContract: TOKEN_SYMBOLS_MAP.USDC.addresses[CHAIN_IDs.MAINNET],
              },
              types: {
                Permit: [
                  { name: "owner", type: "address" },
                  { name: "spender", type: "address" },
                  { name: "value", type: "uint256" },
                  { name: "nonce", type: "uint256" },
                  { name: "deadline", type: "uint256" },
                ],
              },
              value: {
                owner: "0x0000000000000000000000000000000000000001",
                spender: "0x0000000000000000000000000000000000000002",
                value: "1000000",
                nonce: "0",
                deadline: "9999999999",
              },
              deadline: "9999999999",
            },
          },
        ],
      };

      const getOrderQuoteSpy = sinon.spy(mockClient, "getOrderQuote");
      const amount = toBNWei("100", 6);
      await adapter.constructL1ToL2Txn(
        toAddress(await adapter["l1Signer"].getAddress()),
        toAddress(l1UsdcAddress),
        toAddress(l2UsdgAddress),
        amount
      );

      expect(getOrderQuoteSpy.calledOnce).to.be.true;
      const quoteParams = getOrderQuoteSpy.firstCall.args[0];
      expect(quoteParams.permitSignature).to.be.a("string");
      expect(quoteParams.permitDeadline).to.equal("9999999999");
    });
  });

  describe("quoted amountOut outstanding transfers", function () {
    it("records quoted L2 receive amount in Redis after L1 submission", async function () {
      const redisSet = sinon.stub().resolves("OK");
      sinon.stub(redisCache, "getRedisCache").resolves({ set: redisSet } as never);

      await adapter.recordL1ToL2BridgeInitiation("0xabc123", BigNumber.from("9975000"));

      expect(redisSet.calledOnce).to.be.true;
      expect(redisSet.firstCall.args[0]).to.equal(getPaxosTransitQuotedReceiveRedisKey("0xabc123"));
      expect(redisSet.firstCall.args[1]).to.equal("9975000");
    });

    it("uses quoted L2 receive converted to L1 decimals for outstanding-transfer matching", function () {
      const onChainOfferAmount = toBNWei("100", 6);
      const quotedL2Receive = BigNumber.from("9975000");
      const l2TokenDecimals = 18;
      const l1TokenDecimals = 6;

      const adjustedAmount = getPaxosTransitInitiationAmountForOutstandingTransfers(
        onChainOfferAmount,
        quotedL2Receive,
        l2TokenDecimals,
        l1TokenDecimals
      );

      expect(adjustedAmount).to.deep.equal(ConvertDecimals(l2TokenDecimals, l1TokenDecimals)(quotedL2Receive));
      expect(adjustedAmount).to.not.deep.equal(onChainOfferAmount);
    });

    it("falls back to on-chain L1 offer amount when no quote is available", function () {
      const onChainOfferAmount = toBNWei("100", 6);

      expect(
        getPaxosTransitInitiationAmountForOutstandingTransfers(onChainOfferAmount, undefined, 18, 6)
      ).to.deep.equal(onChainOfferAmount);
    });
  });

  describe("API outstanding orders", function () {
    const mainnetUsdgAddress = TOKEN_SYMBOLS_MAP.USDG.addresses[hubChainId];
    let relayerAddress: string;

    beforeEach(async function () {
      relayerAddress = await adapter["l1Signer"].getAddress();
    });

    function buildOrder(overrides: Partial<PaxosTransitOrder>): PaxosTransitOrder {
      return {
        id: "0xorder1",
        offerAsset: l1UsdcAddress,
        wantAsset: l2UsdgAddress,
        offerAmount: "10000000",
        amountDue: "9975000",
        remainingAmountDue: "9975000",
        receiver: relayerAddress,
        sourceChainId: hubChainId,
        destinationChainId: l2ChainId,
        status: "PENDING_BRIDGE",
        ...overrides,
      };
    }

    it("returns outstanding orders for every mainnet offer asset settling to the destination token", async function () {
      mockClient.orders = [
        buildOrder({ id: "0xusdc-pending", remainingAmountDue: "5000000" }),
        buildOrder({
          id: "0xusdg-pending",
          offerAsset: mainnetUsdgAddress,
          remainingAmountDue: "3000000",
        }),
        buildOrder({ id: "0xprocessed", status: "PROCESSED", remainingAmountDue: "0" }),
      ];
      const listOrdersSpy = sinon.spy(mockClient, "listOrders");

      const events = await adapter.getOutstandingTransfersFromApi(toAddress(l1UsdcAddress), toAddress(relayerAddress));

      const bridgeEvents = events[l2UsdgAddress];
      expect(bridgeEvents).to.have.length(2);
      expect(bridgeEvents.map((event) => event.txnRef)).to.deep.equal(["0xusdc-pending", "0xusdg-pending"]);
      expect(listOrdersSpy.callCount).to.equal(1);
      expect(listOrdersSpy.firstCall.args[0].filter).to.equal("status=PROCESSING OR status=PENDING_BRIDGE");
    });

    it("queries on-chain L2 finalization events from BoringVault", async function () {
      const paginatedEventQueryStub = sinon.stub(eventUtils, "paginatedEventQuery").resolves([]);

      const events = await adapter.queryL2BridgeFinalizationEvents(
        toAddress(l1UsdcAddress),
        toAddress(relayerAddress),
        toAddress(relayerAddress),
        { from: 0, to: 100 }
      );

      expect(paginatedEventQueryStub.calledOnce).to.be.true;
      expect(events).to.deep.equal({ [l2UsdgAddress]: [] });
    });

    it("identifies outstanding Paxos orders and matching routes", function () {
      const order = buildOrder({ status: "PROCESSING", remainingAmountDue: "1000" });
      const routeParams = {
        wantAsset: l2UsdgAddress,
        sourceChainId: hubChainId,
        destinationChainId: l2ChainId,
        receiver: relayerAddress,
      };
      expect(isPaxosTransitOrderOutstanding(order)).to.be.true;
      expect(paxosTransitOrderMatchesRoute(order, routeParams)).to.be.true;
      expect(
        paxosTransitOrderMatchesRoute(
          buildOrder({ offerAsset: mainnetUsdgAddress, status: "PROCESSING", remainingAmountDue: "1000" }),
          routeParams
        )
      ).to.be.true;
      expect(isPaxosTransitOrderOutstanding(buildOrder({ status: "PROCESSED", remainingAmountDue: "0" }))).to.be.false;
    });
  });
});
