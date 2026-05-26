import { expect } from "chai";
import { utils, TransactionReceipt } from "../src/utils";
import { DepositAddressMessage } from "../src/interfaces/DepositAddress";
import { buildWithdrawExecutedPayload, ERC20_TRANSFER_TOPIC } from "../src/deposit-address/withdrawPayload";
import { getGcpPubSubPublisher } from "../src/messaging/gcp";

const DEPOSIT_ADDRESS = "0x000000000000000000000000000000000000C0DE";
const REFUND_ADDRESS = "0x0000000000000000000000000000000000002222";
const FEE_RECIPIENT = "0x000000000000000000000000000000000000BEEF";
const TOKEN = "0x000000000000000000000000000000000000DEAD";
const OTHER_TOKEN = "0x0000000000000000000000000000000000005678";
const REFUND_TX = "0xabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefABCD";
const INBOUND_TX = "0x1111111111111111111111111111111111111111111111111111111111111111";

function topicAddress(address: string): string {
  return utils.hexZeroPad(address.toLowerCase(), 32);
}

function depositMessage(): DepositAddressMessage {
  return {
    depositAddress: DEPOSIT_ADDRESS,
    paramsHash: "0x" + "0".repeat(64),
    salt: "0x" + "0".repeat(64),
    counterfactualDepositContractAddress: "0x000000000000000000000000000000000000A1A1",
    counterfactualFactoryContractAddress: "0x000000000000000000000000000000000000A2A2",
    adminWithdrawManagerContractAddress: "0x000000000000000000000000000000000000A3A3",
    shouldSponsorAccountCreation: false,
    counterfactualMaterials: {
      withdrawLeaf: {
        leafHash: "0x" + "0".repeat(64),
        merkleProof: [],
        encodedParams: "0x",
        implementationAddress: "0x000000000000000000000000000000000000A4A4",
      },
    },
    routeParams: {
      inputToken: TOKEN,
      outputToken: TOKEN,
      originChainId: "1",
      destinationChainId: "10",
      recipient: "0x0000000000000000000000000000000000001111",
      refundAddress: REFUND_ADDRESS,
    },
    erc20Transfer: {
      chainId: "1",
      blockNumber: 1_000_000,
      logIndex: 4,
      from: REFUND_ADDRESS,
      to: DEPOSIT_ADDRESS,
      amount: "5000",
      contractAddress: TOKEN,
      transactionHash: INBOUND_TX,
      transferClassification: "intent_refund",
    },
  };
}

function fakeReceipt(logs: Array<Partial<TransactionReceipt["logs"][number]>>): TransactionReceipt {
  return {
    blockNumber: 1_234_567,
    transactionHash: REFUND_TX,
    logs: logs.map((l, i) => ({
      transactionIndex: 0,
      blockNumber: 1_234_567,
      transactionHash: REFUND_TX,
      address: TOKEN,
      topics: [],
      data: "0x",
      logIndex: i,
      blockHash: "0x" + "0".repeat(64),
      removed: false,
      ...l,
    })),
  } as unknown as TransactionReceipt;
}

describe("buildWithdrawExecutedPayload", function () {
  it("picks the Transfer log matching (token, from=depositAddress, to=refundAddress)", function () {
    const receipt = fakeReceipt([
      // Unrelated event from the same token contract (e.g., Approval-like) — wrong topic[0].
      { address: TOKEN, topics: ["0x" + "f".repeat(64), topicAddress(FEE_RECIPIENT), topicAddress(REFUND_ADDRESS)] },
      // Transfer from another address — wrong topic[1].
      { address: TOKEN, topics: [ERC20_TRANSFER_TOPIC, topicAddress(FEE_RECIPIENT), topicAddress(REFUND_ADDRESS)] },
      // Transfer to another address — wrong topic[2].
      { address: TOKEN, topics: [ERC20_TRANSFER_TOPIC, topicAddress(DEPOSIT_ADDRESS), topicAddress(FEE_RECIPIENT)] },
      // Multicall3 deploy log — wrong contract address.
      {
        address: OTHER_TOKEN,
        topics: [ERC20_TRANSFER_TOPIC, topicAddress(DEPOSIT_ADDRESS), topicAddress(REFUND_ADDRESS)],
      },
      // The match.
      { address: TOKEN, topics: [ERC20_TRANSFER_TOPIC, topicAddress(DEPOSIT_ADDRESS), topicAddress(REFUND_ADDRESS)] },
    ]);

    const payload = buildWithdrawExecutedPayload(receipt, depositMessage());
    expect(payload).to.not.be.undefined;
    expect(payload).to.deep.equal({
      type: "withdraw_executed",
      data: {
        chainId: 1,
        blockNumber: 1_234_567,
        txHash: REFUND_TX.toLowerCase(),
        logIndex: 4,
        erc20Transfer: {
          chainId: 1,
          blockNumber: 1_000_000,
          txHash: INBOUND_TX,
          logIndex: 4,
        },
      },
    });
  });

  it("matches case-insensitively on token, depositAddress, and refundAddress", function () {
    const message = depositMessage();
    message.erc20Transfer.contractAddress = TOKEN.toUpperCase().replace("0X", "0x");
    message.routeParams.refundAddress = REFUND_ADDRESS.toUpperCase().replace("0X", "0x");
    const receipt = fakeReceipt([
      {
        address: TOKEN.toLowerCase(),
        topics: [ERC20_TRANSFER_TOPIC, topicAddress(DEPOSIT_ADDRESS), topicAddress(REFUND_ADDRESS)],
      },
    ]);
    const payload = buildWithdrawExecutedPayload(receipt, message);
    expect(payload?.data.logIndex).to.equal(0);
  });

  it("returns undefined when no Transfer (depositAddress -> refundAddress) exists in the receipt", function () {
    const receipt = fakeReceipt([
      // Right shape but wrong token.
      {
        address: OTHER_TOKEN,
        topics: [ERC20_TRANSFER_TOPIC, topicAddress(DEPOSIT_ADDRESS), topicAddress(REFUND_ADDRESS)],
      },
      // Inbound transfer (from = refundAddress) — wrong direction.
      { address: TOKEN, topics: [ERC20_TRANSFER_TOPIC, topicAddress(REFUND_ADDRESS), topicAddress(DEPOSIT_ADDRESS)] },
    ]);
    expect(buildWithdrawExecutedPayload(receipt, depositMessage())).to.be.undefined;
  });

  it("disambiguates fee-on-transfer tokens by selecting the deposit->refund transfer, not the deposit->fee transfer", function () {
    // Typical fee-on-transfer token: a single user-facing transfer emits two ERC20 Transfer
    // events from the sender — one to the recipient, one to a fee recipient.
    const receipt = fakeReceipt([
      // Fee leg — same `from`, but `to` is the fee recipient, not the user.
      { address: TOKEN, topics: [ERC20_TRANSFER_TOPIC, topicAddress(DEPOSIT_ADDRESS), topicAddress(FEE_RECIPIENT)] },
      // Settlement leg — the one we want.
      { address: TOKEN, topics: [ERC20_TRANSFER_TOPIC, topicAddress(DEPOSIT_ADDRESS), topicAddress(REFUND_ADDRESS)] },
    ]);
    const payload = buildWithdrawExecutedPayload(receipt, depositMessage());
    expect(payload?.data.logIndex).to.equal(1);
  });

  it("picks the LAST matching Transfer log when multiple deposit->refund transfers exist (e.g. Multicall3-bundled withdraw)", function () {
    const receipt = fakeReceipt([
      // Intermediate transfer from the deposit address to the refund address.
      { address: TOKEN, topics: [ERC20_TRANSFER_TOPIC, topicAddress(DEPOSIT_ADDRESS), topicAddress(REFUND_ADDRESS)] },
      // Unrelated log between the two matches.
      {
        address: OTHER_TOKEN,
        topics: [ERC20_TRANSFER_TOPIC, topicAddress(FEE_RECIPIENT), topicAddress(REFUND_ADDRESS)],
      },
      // Final settlement transfer from the deposit address — this is the one we want.
      { address: TOKEN, topics: [ERC20_TRANSFER_TOPIC, topicAddress(DEPOSIT_ADDRESS), topicAddress(REFUND_ADDRESS)] },
    ]);
    const payload = buildWithdrawExecutedPayload(receipt, depositMessage());
    expect(payload?.data.logIndex).to.equal(2);
  });
});

describe("getGcpPubSubPublisher", function () {
  it("returns undefined under RELAYER_TEST", function () {
    // The mocha runner already sets RELAYER_TEST=true (see the `test` package script),
    // so this asserts the short-circuit fires for the real test invocation.
    expect(process.env.RELAYER_TEST).to.equal("true");
    expect(getGcpPubSubPublisher(undefined, "any-project")).to.be.undefined;
  });

  it("returns undefined when projectId is missing", function () {
    // The RELAYER_TEST short-circuit fires first, so this primarily documents intent.
    expect(getGcpPubSubPublisher(undefined, "")).to.be.undefined;
    expect(getGcpPubSubPublisher(undefined, undefined)).to.be.undefined;
  });
});
