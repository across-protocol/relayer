import { CHAIN_IDs, TOKEN_SYMBOLS_MAP } from "@across-protocol/constants";
import { ethers } from "hardhat";
import { PaxosTransitBridge } from "../../src/adapter/bridges/PaxosTransitBridge";
import { expect, createSpyLogger, sinon, toBNWei, randomAddress } from "../utils";
import {
  EvmAddress,
  PAXOS_TRANSIT_DESTINATION_TOKENS,
  PAXOS_TRANSIT_MINIMUMS,
  PaxosTransitClient,
  PaxosTransitOrderDataResponse,
} from "../../src/utils";
import * as contractUtils from "../../src/utils/ContractUtils";

class MockPaxosTransitClient extends PaxosTransitClient {
  public authorizationMethod: "already_approved" | "permit" | "approval" = "already_approved";
  public orderData: PaxosTransitOrderDataResponse = {
    transaction: {
      to: "0x1111111111111111111111111111111111111111",
      data: "0xdeadbeef",
      value: "0",
    },
  };

  constructor() {
    super("https://mock-paxos.test", "test-api-key");
  }

  async getAuthorization() {
    if (this.authorizationMethod === "permit") {
      return {
        method: "permit" as const,
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
      };
    }
    return { method: this.authorizationMethod };
  }

  async getOrderData() {
    return this.orderData;
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
  });
});
