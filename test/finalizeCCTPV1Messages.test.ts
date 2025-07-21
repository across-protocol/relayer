import { SvmSpokeClient } from "@across-protocol/contracts";
import { encodeMessageHeader } from "@across-protocol/contracts/dist/src/svm/web3-v1";
import { signature } from "@solana/kit";
import { PublicKey } from "@solana/web3.js";
import { expect } from "chai";
import { arch } from "@across-protocol/sdk";
import { signer } from "./Solana.setup";
import { createDefaultSolanaClient, encodePauseDepositsMessageBody } from "./utils/svm/utils";
import { finalizeCCTPV1Messages } from "../src/finalizer/utils/cctp/l1ToL2";
import { AttestedCCTPMessage } from "../src/utils/CCTPUtils";

// Define an extended interface for our Solana client with chainId
interface ExtendedSolanaClient extends ReturnType<typeof createDefaultSolanaClient> {
  chainId: number;
}

// Helper function for the new tests
const getAttestedMessage = async (
  messageBody: Buffer,
  nonce: number,
  sourceDomain = 0,
  destinationDomain = 5
): Promise<AttestedCCTPMessage[]> => {
  const testSolanaClient = createDefaultSolanaClient();
  const stateData = await SvmSpokeClient.fetchState(
    testSolanaClient.rpc,
    await arch.svm.getStatePda(SvmSpokeClient.SVM_SPOKE_PROGRAM_ADDRESS)
  );
  const messageBytes = encodeMessageHeader({
    version: 0,
    sourceDomain,
    destinationDomain,
    nonce: BigInt(nonce),
    sender: new PublicKey(stateData.data.crossDomainAdmin),
    recipient: new PublicKey(SvmSpokeClient.SVM_SPOKE_PROGRAM_ADDRESS),
    destinationCaller: new PublicKey(new Uint8Array(32)),
    messageBody,
  });

  return [
    {
      cctpVersion: 1,
      sourceDomain,
      destinationDomain,
      sender: stateData.data.crossDomainAdmin,
      recipient: SvmSpokeClient.SVM_SPOKE_PROGRAM_ADDRESS,
      messageHash: "0xabcdef1234567890",
      messageBytes: messageBytes.toString("hex"),
      nonce,
      nonceHash: "0x1234567890abcdef",
      attestation: "0x",
      status: "ready",
      log: {
        transactionHash: "0x1234567890abcdef",
        logIndex: 0,
        blockNumber: 1,
        blockHash: "0xabcdef1234567890",
        transactionIndex: 0,
        removed: false,
        address: SvmSpokeClient.SVM_SPOKE_PROGRAM_ADDRESS,
        data: "0x",
        topics: [],
        event: "MessageSent",
        args: {},
      },
    } as AttestedCCTPMessage,
  ];
};

describe("finalizeCCTPV1Messages", () => {
  const solanaClient = createDefaultSolanaClient() as ExtendedSolanaClient;

  it("should simulate CCTP message finalization successfully", async () => {
    const nonce = 100;
    const attestedMessages = await getAttestedMessage(encodePauseDepositsMessageBody(true), nonce, 0, 5);
    const isNonceUsed = await arch.svm.hasCCTPV1MessageBeenProcessed(solanaClient.rpc, signer, nonce, 0);

    expect(isNonceUsed).to.equal(false);

    // Test simulation mode
    const signatures = await finalizeCCTPV1Messages(
      solanaClient.rpc,
      attestedMessages,
      signer,
      true, // simulate = true
      0 // hubChainId
    );

    expect(signatures).to.be.an("array");
    expect(signatures).to.have.length(1);
    expect(signatures[0]).to.equal(""); // Simulation returns empty string
  });

  it("should finalize CCTP messages successfully", async () => {
    const nonce = 101;
    const attestedMessages = await getAttestedMessage(encodePauseDepositsMessageBody(false), nonce, 0, 5);
    const statePda = await arch.svm.getStatePda(SvmSpokeClient.SVM_SPOKE_PROGRAM_ADDRESS);
    let isNonceUsed = await arch.svm.hasCCTPV1MessageBeenProcessed(solanaClient.rpc, signer, nonce, 0);

    expect(isNonceUsed).to.equal(false);
    // Test actual finalization
    const signatures = await finalizeCCTPV1Messages(
      solanaClient.rpc,
      attestedMessages,
      signer,
      false, // simulate = false
      0 // hubChainId
    );

    expect(signatures).to.be.an("array");
    expect(signatures).to.have.length(1);
    expect(signatures[0]).to.be.a("string");
    expect(signatures[0]).to.not.equal("");

    // Wait for transaction confirmation
    await solanaClient.rpc
      .getTransaction(signature(signatures[0]), {
        commitment: "finalized",
        maxSupportedTransactionVersion: 0,
      })
      .send();

    await new Promise((resolve) => setTimeout(resolve, 500));

    const state = await SvmSpokeClient.fetchState(solanaClient.rpc, statePda);

    expect(state.data.pausedDeposits).to.equal(false);

    isNonceUsed = await arch.svm.hasCCTPV1MessageBeenProcessed(solanaClient.rpc, signer, nonce, 0);

    expect(isNonceUsed).to.equal(true);
  });

  it("should handle multiple messages in batch", async () => {
    const nonce1 = 102;
    const nonce2 = 103;

    const message1 = await getAttestedMessage(encodePauseDepositsMessageBody(true), nonce1, 0, 5);
    const message2 = await getAttestedMessage(encodePauseDepositsMessageBody(false), nonce2, 0, 5);

    let isNonceUsed = await arch.svm.hasCCTPV1MessageBeenProcessed(solanaClient.rpc, signer, nonce1, 0);
    expect(isNonceUsed).to.equal(false);
    isNonceUsed = await arch.svm.hasCCTPV1MessageBeenProcessed(solanaClient.rpc, signer, nonce2, 0);
    expect(isNonceUsed).to.equal(false);

    const statePda = await arch.svm.getStatePda(SvmSpokeClient.SVM_SPOKE_PROGRAM_ADDRESS);

    const attestedMessages = [...message1, ...message2];

    const signatures = await finalizeCCTPV1Messages(
      solanaClient.rpc,
      attestedMessages,
      signer,
      false, // simulate = false
      0 // hubChainId
    );

    expect(signatures).to.be.an("array");
    expect(signatures).to.have.length(2);
    expect(signatures[0]).to.be.a("string");
    expect(signatures[1]).to.be.a("string");
    expect(signatures[0]).to.not.equal("");
    expect(signatures[1]).to.not.equal("");

    // Wait for transaction confirmations
    await Promise.all(
      signatures.map(async (sig) => {
        await solanaClient.rpc
          .getTransaction(signature(sig), {
            commitment: "finalized",
            maxSupportedTransactionVersion: 0,
          })
          .send();
      })
    );

    await new Promise((resolve) => setTimeout(resolve, 500));

    const state = await SvmSpokeClient.fetchState(solanaClient.rpc, statePda);

    expect(state.data.pausedDeposits).to.equal(true);

    isNonceUsed = await arch.svm.hasCCTPV1MessageBeenProcessed(solanaClient.rpc, signer, nonce1, 0);
    expect(isNonceUsed).to.equal(true);

    isNonceUsed = await arch.svm.hasCCTPV1MessageBeenProcessed(solanaClient.rpc, signer, nonce2, 0);
    expect(isNonceUsed).to.equal(true);
  });

  it("should throw error when simulation fails", async () => {
    // Create an invalid message that should cause simulation to fail
    const invalidMessage: AttestedCCTPMessage = {
      cctpVersion: 1,
      sourceDomain: 0,
      destinationDomain: 5,
      sender: "invalid_sender",
      recipient: "invalid_recipient",
      messageHash: "0xabcdef1234567890",
      messageBytes: "invalid_message_bytes",
      nonce: 999,
      nonceHash: "0x1234567890abcdef",
      attestation: "0x",
      status: "ready",
      log: {
        transactionHash: "0x1234567890abcdef",
        logIndex: 0,
        blockNumber: 1,
        blockHash: "0xabcdef1234567890",
        transactionIndex: 0,
        removed: false,
        address: "invalid_address",
        data: "0x",
        topics: [],
        event: "MessageSent",
        args: {},
      },
    };

    try {
      await finalizeCCTPV1Messages(
        solanaClient.rpc,
        [invalidMessage],
        signer,
        true, // simulate = true
        0 // hubChainId
      );
      expect.fail("Should have thrown an error");
    } catch (error) {
      expect(error).to.be.instanceOf(Error);
    }
  });

  it("should handle empty messages array", async () => {
    const signatures = await finalizeCCTPV1Messages(
      solanaClient.rpc,
      [], // empty array
      signer,
      false,
      0
    );

    expect(signatures).to.be.an("array");
    expect(signatures).to.have.length(0);
  });
});
