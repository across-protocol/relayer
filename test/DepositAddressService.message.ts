import { expect } from "./utils";
import { parseTransfer, transferId } from "../src/deposit-address-service/message";
import { DepositAddressMessageV3 } from "../src/interfaces/DepositAddress";

/** Minimal valid v3 item. Deep-merged overrides keep each test to the field under examination. */
function v3(overrides: Record<string, unknown> = {}, transferOverrides: Record<string, unknown> = {}): string {
  const message = {
    depositAddress: "0x9f4Ae3C1b28D5e07A6f1B4c93D2e8a05F7c61B3d",
    version: 3,
    salt: "0x01",
    initialRoot: "0x02",
    counterfactualBeaconContractAddress: "0x03",
    counterfactualFactoryContractAddress: "0x04",
    adminWithdrawManagerContractAddress: "0x05",
    shouldSponsorAccountCreation: false,
    counterfactualMaterials: [
      { kind: "withdraw", implementationAddress: "0x06", encodedParams: "0x", leafHash: "0x07", merkleProof: ["0x08"] },
    ],
    routeParams: {
      outputToken: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
      destinationChainId: "8453",
      recipient: { namespace: "evm", address: "0x0a" },
    },
    refundAddress: { namespace: "evm", address: "0x0b" },
    depositAddressNamespace: "evm",
    erc20Transfer: {
      chainId: "42161",
      blockNumber: 312884201,
      logIndex: 7,
      from: "0x0c",
      to: "0x9f4Ae3C1b28D5e07A6f1B4c93D2e8a05F7c61B3d",
      amount: "25000000",
      contractAddress: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
      transactionHash: "0xA3F1C7D40E9B6852F1AD0C3B7E94F628A1D5C09E",
      transferClassification: "correct_transfer",
      ...transferOverrides,
    },
    integrator: { name: "acme", integratorId: "0x0a1b" },
    ...overrides,
  };
  return JSON.stringify(message);
}

describe("transferId", function () {
  const transfer = (over: Record<string, unknown> = {}) =>
    ({
      chainId: "42161",
      blockNumber: 1,
      logIndex: 7,
      transactionHash: "0xABC",
      ...over,
    }) as unknown as DepositAddressMessageV3["erc20Transfer"];

  it("is chainId:txHash:logIndex, normalised", function () {
    expect(transferId(transfer())).to.equal("42161:0xabc:7");
  });

  it("is stable across the representations the indexer can send", function () {
    // chainId arrives as a string and hash casing varies; the same transfer must not yield two ids.
    expect(transferId(transfer({ chainId: "42161" }))).to.equal(transferId(transfer({ chainId: 42161 })));
    expect(transferId(transfer({ transactionHash: "0xABC" }))).to.equal(
      transferId(transfer({ transactionHash: "0xabc" }))
    );
  });

  it("distinguishes two transfers in one transaction", function () {
    // The polling bot's getDepositKey omits logIndex and collides here.
    expect(transferId(transfer({ logIndex: 7 }))).to.not.equal(transferId(transfer({ logIndex: 8 })));
  });
});

describe("parseTransfer", function () {
  it("returns the transferId and the message as the indexer stated it", function () {
    const parsed = parseTransfer(v3());
    expect(parsed.transferId).to.equal("42161:0xa3f1c7d40e9b6852f1ad0c3b7e94f628a1d5c09e:7");
    expect(parsed.message.erc20Transfer.amount).to.equal("25000000");
    expect(parsed.message.erc20Transfer.transferClassification).to.equal("correct_transfer");
  });

  it("passes an actionable classification through untranslated", function () {
    // Deliberately no deposit/withdraw label here: a correct_transfer the execute endpoint rejects as below
    // the minimum becomes a refund withdraw, so the action is not knowable at parse time.
    const parsed = parseTransfer(v3({}, { transferClassification: "mis_route" }));
    expect(parsed.message.erc20Transfer.transferClassification).to.equal("mis_route");
    expect("route" in parsed).to.equal(false);
  });

  it("drops classifications v3 does not support", function () {
    // intent_refund is unsupported on v3, matching the polling bot.
    expect(() => parseTransfer(v3({}, { transferClassification: "intent_refund" }))).to.throw(/does not support/);
  });

  it("drops unsupported versions before validating the rest", function () {
    for (const version of [1, 2, undefined, "3"]) {
      expect(() => parseTransfer(v3({ version })), String(version)).to.throw(/unsupported message version/);
    }
  });

  it("rejects payloads that are not JSON", function () {
    expect(() => parseTransfer("{not json")).to.throw(/not JSON/);
  });

  it("names the offending field when the shape breaks", function () {
    const missingRefund = JSON.parse(v3()) as Record<string, unknown>;
    delete missingRefund.refundAddress;
    expect(() => parseTransfer(JSON.stringify(missingRefund))).to.throw(/refundAddress/);

    const badAmount = JSON.parse(v3()) as { erc20Transfer: Record<string, unknown> };
    badAmount.erc20Transfer.amount = 25000000;
    expect(() => parseTransfer(JSON.stringify(badAmount))).to.throw(/erc20Transfer.amount/);
  });

  it("accepts a message with no integrator", function () {
    // Pre-integrator deposit addresses omit it; the execute path validates the id separately.
    expect(parseTransfer(v3({ integrator: undefined })).message.integrator).to.equal(undefined);
    expect(parseTransfer(v3({ integrator: null })).message.integrator).to.equal(null);
  });

  it("tolerates unknown fields so an indexer addition cannot break the service", function () {
    const parsed = parseTransfer(v3({ someFutureField: { nested: true } }));
    expect(parsed.transferId).to.equal("42161:0xa3f1c7d40e9b6852f1ad0c3b7e94f628a1d5c09e:7");
  });
});
