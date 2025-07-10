import { expect } from "chai";
import axios from "axios";
import { ethers } from "ethers";
import hre from "hardhat";

import { cmpAPIToEventMessageBytesV2 } from "../../src/utils/CCTPUtils";

// Problematic Circle CCTP batch transaction reported in Slack thread
const TX_HASH = "0xa64e3d831c3a0c94a25863d5fa3627f9626ccded551edab147fddae6b28f1d82";
const SOURCE_DOMAIN = 0; // Ethereum mainnet

describe("CCTP Integration: match API messages to on-chain events", function () {
  // This test performs live RPC & HTTPS calls.  Allow a generous timeout.
  this.timeout(60_000);

  // Skip the test completely if the developer hasn't supplied a mainnet RPC URL
  before(function () {
    if (!process.env.MAINNET_RPC_URL) {
      // eslint-disable-next-line no-console
      console.warn("⚠️  MAINNET_RPC_URL not set – skipping CCTP integration test.");
      this.skip();
    }
  });

  it("matches every MessageSent byte payload against Circle API regardless of ordering", async function () {
    // 1. Spin up a local fork at the block containing the txn (optional, improves speed & determinism)
    const rpcUrl = process.env.MAINNET_RPC_URL!;
    const tx = await (new ethers.providers.StaticJsonRpcProvider(rpcUrl)).getTransaction(TX_HASH);
    expect(tx).to.not.be.null;

    // Hardhat local fork so that we continue using hre.ethers.provider for uniformity
    await hre.network.provider.request({
      method: "hardhat_reset",
      params: [
        {
          forking: {
            jsonRpcUrl: rpcUrl,
            blockNumber: tx.blockNumber,
          },
        },
      ],
    });

    const provider = hre.ethers.provider as ethers.providers.JsonRpcProvider;

    // 2. Pull on-chain logs for MessageSent(bytes) events from that tx
    const receipt = await provider.getTransactionReceipt(TX_HASH);
    const MESSAGE_SENT_TOPIC = ethers.utils.id("MessageSent(bytes)");

    const eventMessageBytes: string[] = receipt.logs
      .filter((log) => log.topics[0] === MESSAGE_SENT_TOPIC)
      .map((log) => {
        // MessageSent(bytes) has a single indexed parameter: the bytes payload is in log.data (ABI-encoded as bytes)
        return ethers.utils.defaultAbiCoder.decode(["bytes"], log.data)[0] as string;
      });

    expect(eventMessageBytes.length).to.be.greaterThan(0);

    // 3. Fetch Circle API messages for the transaction
    const { data } = await axios.get(`https://iris-api.circle.com/v2/messages/${SOURCE_DOMAIN}?transactionHash=${TX_HASH}`);
    const apiMessages: { message: string }[] = data.messages;
    expect(apiMessages.length).to.equal(eventMessageBytes.length);

    // 4. Ensure each event message can be matched to one API message irrespective of order
    const unmatched = [...apiMessages];
    for (const localBytes of eventMessageBytes) {
      const idx = unmatched.findIndex(({ message }) => cmpAPIToEventMessageBytesV2(message, localBytes));
      expect(idx, "should find a matching attestation").to.be.greaterThan(-1);
      // Remove so we don't double-match
      unmatched.splice(idx, 1);
    }

    // After processing all local messages, there should be no unmatched API messages left.
    expect(unmatched.length).to.equal(0);
  });
});