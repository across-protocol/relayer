import { CHAIN_IDs, TOKEN_SYMBOLS_MAP } from "@across-protocol/constants";
import { ethers } from "hardhat";
import { PaxosTransitBridge } from "../../src/adapter/bridges/PaxosTransitBridge";
import { expect, createSpyLogger, sinon, toBNWei, randomAddress } from "../utils";
import {
  EvmAddress,
  PAXOS_TRANSIT_DESTINATION_TOKENS,
  PAXOS_TRANSIT_MINIMUMS,
  PaxosTransitClient,
  PaxosTransitOrderQuoteResponse,
  getPaxosTransitStationAddress,
  getPaxosTransitBoringVaultAddress,
} from "../../src/utils";
import * as contractUtils from "../../src/utils/ContractUtils";

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

  constructor() {
    super("https://mock-paxos.test", "test-api-key");
  }

  async getAuthorization() {
    return this.authorizationResponse;
  }

  async getOrderQuote() {
    return this.orderQuote;
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

      expect(getPaxosTransitStationAddress(CHAIN_IDs.MAINNET)).to.equal(
        "0x49AAA987b1a7e9E4AE091dcD8332c39F322D7d28"
      );
      expect(getPaxosTransitStationAddress(CHAIN_IDs.ROBINHOOD)).to.equal(
        "0x49AAA987b1a7e9E4AE091dcD8332c39F322D7d28"
      );
      expect(getPaxosTransitBoringVaultAddress(CHAIN_IDs.MAINNET)).to.equal(
        "0x91fe06c6e9f97e7de4580a280e03046155f8e1e3"
      );
      expect(getPaxosTransitBoringVaultAddress(CHAIN_IDs.ROBINHOOD)).to.equal(
        "0x91fe06c6e9f97e7de4580a280e03046155f8e1e3"
      );
    });

    it("prefers env override over ContractAddresses default", function () {
      process.env.PAXOS_TRANSIT_STATION_1 = "0x2222222222222222222222222222222222222222";
      expect(getPaxosTransitStationAddress(CHAIN_IDs.MAINNET)).to.equal(
        "0x2222222222222222222222222222222222222222"
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
      const waitForTransaction = sinon
        .stub(adapter["l1Signer"].provider!, "waitForTransaction")
        .resolves({} as never);

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
});
