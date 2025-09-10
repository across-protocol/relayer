import { SvmSpokeClient } from "@across-protocol/contracts";
import { encodeMessageHeader } from "@across-protocol/contracts/dist/src/svm/web3-v1";
import { signature } from "@solana/kit";
import { PublicKey } from "@solana/web3.js";
import { expect } from "chai";
import { arch, clients } from "@across-protocol/sdk";
import { createDefaultSolanaClient, encodePauseDepositsMessageBody } from "./utils/svm/utils";
import { signer } from "./Solana.setup";
import { finalizeCCTPV1MessagesSVM, cctpL1toL2Finalizer } from "../src/finalizer/utils/cctp";
import { AttestedCCTPMessage, ZERO_ADDRESS } from "../src/utils";
import { FinalizerPromise } from "../src/finalizer/types";
import { createSpyLogger, ethers, getContractFactory } from "./utils";
import { setupDataworker } from "./fixtures/Dataworker.Fixture";
import sinon from "sinon";
import * as CCTPUtils from "../src/utils/CCTPUtils";
import * as svmSignerUtils from "../src/utils/SvmSignerUtils";

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
  const { spyLogger } = createSpyLogger();
  let hubPoolClient: clients.HubPoolClient;

  beforeEach(async function () {
    ({ hubPoolClient } = await setupDataworker(ethers, 25, 25, 0));
    await hubPoolClient.update();
  });

  afterEach(() => {
    sinon.restore();
  });

  it("should simulate CCTP message finalization successfully", async () => {
    // This test is trying to simulate the finalization of a CCTP pauseDeposits message.
    // Create a proper l2SpokePoolClient for Solana
    const l2SpokePoolClient = await clients.SVMSpokePoolClient.create(
      spyLogger,
      hubPoolClient,
      5, // chainId
      0n, // deploymentBlock
      { from: 0 },
      solanaClient.rpc // eventSearchConfig
    );
    const nonce = 100;
    const attestedMessages = await getAttestedMessage(encodePauseDepositsMessageBody(true), nonce, 0, 5);
    const isNonceUsed = await arch.svm.hasCCTPV1MessageBeenProcessed(solanaClient.rpc, signer, nonce, 0);

    expect(isNonceUsed).to.equal(false);

    // Test simulation mode
    const signatures = await finalizeCCTPV1MessagesSVM(
      l2SpokePoolClient,
      attestedMessages,
      signer,
      spyLogger,
      true, // simulate = true
      0 // hubChainId
    );

    expect(signatures).to.be.an("array");
    expect(signatures).to.have.length(1);
    expect(signatures[0]).to.equal(""); // Simulation returns empty string
  });

  it("should finalize CCTP messages successfully", async () => {
    // This test is trying to finalize a CCTP pauseDeposits message.
    const l2SpokePoolClient = await clients.SVMSpokePoolClient.create(
      spyLogger,
      hubPoolClient,
      5, // chainId
      0n, // deploymentBlock
      { from: 0 },
      solanaClient.rpc // eventSearchConfig
    );
    const nonce = 101;
    const attestedMessages = await getAttestedMessage(encodePauseDepositsMessageBody(false), nonce, 0, 5);
    const statePda = await arch.svm.getStatePda(SvmSpokeClient.SVM_SPOKE_PROGRAM_ADDRESS);
    let isNonceUsed = await arch.svm.hasCCTPV1MessageBeenProcessed(solanaClient.rpc, signer, nonce, 0);

    expect(isNonceUsed).to.equal(false);
    // Test actual finalization
    const signatures = await finalizeCCTPV1MessagesSVM(
      l2SpokePoolClient,
      attestedMessages,
      signer,
      spyLogger,
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
    // This test is trying to finalize pause and unpause deposits messages in a batch.
    const l2SpokePoolClient = await clients.SVMSpokePoolClient.create(
      spyLogger,
      hubPoolClient,
      5, // chainId
      0n, // deploymentBlock
      { from: 0 },
      solanaClient.rpc // eventSearchConfig
    );
    const nonce1 = 102;
    const nonce2 = 103;

    const message1 = await getAttestedMessage(encodePauseDepositsMessageBody(true), nonce1, 0, 5);
    const message2 = await getAttestedMessage(encodePauseDepositsMessageBody(false), nonce2, 0, 5);

    let isNonceUsed = await arch.svm.hasCCTPV1MessageBeenProcessed(solanaClient.rpc, signer, nonce1, 0);
    expect(isNonceUsed).to.equal(false);
    isNonceUsed = await arch.svm.hasCCTPV1MessageBeenProcessed(solanaClient.rpc, signer, nonce2, 0);
    expect(isNonceUsed).to.equal(false);

    const attestedMessages = [...message1, ...message2];

    const signatures = await finalizeCCTPV1MessagesSVM(
      l2SpokePoolClient,
      attestedMessages,
      signer,
      spyLogger,
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

    isNonceUsed = await arch.svm.hasCCTPV1MessageBeenProcessed(solanaClient.rpc, signer, nonce1, 0);
    expect(isNonceUsed).to.equal(true);

    isNonceUsed = await arch.svm.hasCCTPV1MessageBeenProcessed(solanaClient.rpc, signer, nonce2, 0);
    expect(isNonceUsed).to.equal(true);
  });

  it("should throw error when simulation fails", async () => {
    // This test is trying to simulate finalization of invalid messages to test error handling.
    const l2SpokePoolClient = await clients.SVMSpokePoolClient.create(
      spyLogger,
      hubPoolClient,
      5, // chainId
      0n, // deploymentBlock
      { from: 0 },
      solanaClient.rpc // eventSearchConfig
    );
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
      await finalizeCCTPV1MessagesSVM(
        l2SpokePoolClient,
        [invalidMessage],
        signer,
        spyLogger,
        true, // simulate = true
        0 // hubChainId
      );
      expect.fail("Should have thrown an error");
    } catch (error) {
      expect(error).to.be.instanceOf(Error);
    }
  });

  it("should handle empty messages array", async () => {
    const l2SpokePoolClient = await clients.SVMSpokePoolClient.create(
      spyLogger,
      hubPoolClient,
      5, // chainId
      0n, // deploymentBlock
      { from: 0 },
      solanaClient.rpc // eventSearchConfig
    );
    const signatures = await finalizeCCTPV1MessagesSVM(
      l2SpokePoolClient,
      [], // empty array
      signer,
      spyLogger,
      false,
      0
    );

    expect(signatures).to.be.an("array");
    expect(signatures).to.have.length(0);
  });

  it("should simulate Solana CCTP messages successfully", async () => {
    // This test is trying to simulate the finalization of a CCTP pauseDeposits message.
    // It tests cctpL1toL2Finalizer function.
    // Create a test message

    const testMessages = await getAttestedMessage(encodePauseDepositsMessageBody(true), 200, 0, 5);
    sinon.stub(CCTPUtils, "getAttestedCCTPMessages").resolves(testMessages);
    sinon.stub(CCTPUtils, "getCctpMessageTransmitter").returns({
      address: "CCTPmbSD7gX1bxKPAmg77w8oFzNFpaQiQUWD43TKaecd",
    });
    sinon.stub(svmSignerUtils, "getKitKeypairFromEvmSigner").resolves(signer);

    let originalSendTransactions: string | undefined;
    try {
      // Set environment to not send transactions (simulate mode)
      originalSendTransactions = process.env.SEND_TRANSACTIONS;
      process.env.SEND_TRANSACTIONS = "false";

      // Create a proper EVM client using MockSpokePool contract
      const [deployer] = await ethers.getSigners();
      const spokePool = await (await getContractFactory("MockSpokePool", deployer)).deploy(ZERO_ADDRESS);
      const evmSpokePoolClient = new clients.EVMSpokePoolClient(
        spyLogger,
        spokePool, // This should be the contract, not null
        hubPoolClient, // hubPoolClient
        1, // chainId
        0, // deploymentBlock
        { from: 0 } // eventSearchConfig
      );

      // Create a proper l2SpokePoolClient for Solana
      const l2SpokePoolClient = await clients.SVMSpokePoolClient.create(
        spyLogger,
        hubPoolClient,
        5, // chainId
        0n, // deploymentBlock
        { from: 0 },
        createDefaultSolanaClient().rpc // eventSearchConfig
      );

      const result: FinalizerPromise = await cctpL1toL2Finalizer(
        spyLogger,
        hubPoolClient.hubPool.signer,
        hubPoolClient as any, // Cast to local HubPoolClient type
        l2SpokePoolClient,
        evmSpokePoolClient,
        ["0x1234567890123456789012345678901234567890"] as any
      );

      // Verify the result structure
      expect(result).to.have.property("crossChainMessages");
      expect(result).to.have.property("callData");
      expect(result.crossChainMessages).to.be.an("array");
      expect(result.callData).to.be.an("array");

      // For Solana, crossChainMessages should be empty and callData should be empty
      // because the finalization happens directly in the function
      expect(result.crossChainMessages).to.have.length(0);
      expect(result.callData).to.have.length(0);
    } finally {
      if (originalSendTransactions !== undefined) {
        process.env.SEND_TRANSACTIONS = originalSendTransactions;
      }
    }
  });

  it("should process Solana CCTP messages successfully", async () => {
    // This test is trying to finalize the a CCTP pauseDeposits message.
    // It tests cctpL1toL2Finalizer function.
    // Create a test message
    const testMessages = await getAttestedMessage(encodePauseDepositsMessageBody(true), 200, 0, 5);
    sinon.stub(CCTPUtils, "getAttestedCCTPMessages").resolves(testMessages);
    sinon.stub(CCTPUtils, "getCctpMessageTransmitter").returns({
      address: "CCTPmbSD7gX1bxKPAmg77w8oFzNFpaQiQUWD43TKaecd",
    });
    sinon.stub(svmSignerUtils, "getKitKeypairFromEvmSigner").resolves(signer);

    let originalSendTransactions: string | undefined;
    try {
      // Set environment to not send transactions (simulate mode)
      originalSendTransactions = process.env.SEND_TRANSACTIONS;
      process.env.SEND_TRANSACTIONS = "true";

      // Create a proper EVM client using MockSpokePool contract
      const [deployer] = await ethers.getSigners();
      const spokePool = await (await getContractFactory("MockSpokePool", deployer)).deploy(ZERO_ADDRESS);
      const evmSpokePoolClient = new clients.EVMSpokePoolClient(
        spyLogger,
        spokePool, // This should be the contract, not null
        hubPoolClient, // hubPoolClient
        1, // chainId
        0, // deploymentBlock
        { from: 0 } // eventSearchConfig
      );

      // Create a proper l2SpokePoolClient for Solana
      const l2SpokePoolClient = await clients.SVMSpokePoolClient.create(
        spyLogger,
        hubPoolClient,
        5, // chainId
        0n, // deploymentBlock
        { from: 0 },
        createDefaultSolanaClient().rpc // eventSearchConfig
      );

      const result: FinalizerPromise = await cctpL1toL2Finalizer(
        spyLogger,
        hubPoolClient.hubPool.signer,
        hubPoolClient as any, // Cast to local HubPoolClient type
        l2SpokePoolClient,
        evmSpokePoolClient,
        ["0x1234567890123456789012345678901234567890"] as any
      );

      // Verify the result structure
      expect(result).to.have.property("crossChainMessages");
      expect(result).to.have.property("callData");
      expect(result.crossChainMessages).to.be.an("array");
      expect(result.callData).to.be.an("array");

      // For Solana, crossChainMessages should be empty and callData should be empty
      // because the finalization happens directly in the function
      expect(result.crossChainMessages).to.have.length(0);
      expect(result.callData).to.have.length(0);
    } finally {
      if (originalSendTransactions !== undefined) {
        process.env.SEND_TRANSACTIONS = originalSendTransactions;
      }
    }
  });

  it("should handle empty message list", async () => {
    // This test is trying to handle empty message list.
    // It tests cctpL1toL2Finalizer function.
    sinon.stub(CCTPUtils, "getAttestedCCTPMessages").resolves([]);
    sinon.stub(CCTPUtils, "getCctpMessageTransmitter").returns({
      address: "CCTPmbSD7gX1bxKPAmg77w8oFzNFpaQiQUWD43TKaecd",
    });
    sinon.stub(svmSignerUtils, "getKitKeypairFromEvmSigner").resolves(signer);

    let originalSendTransactions: string | undefined;
    try {
      // Set environment to not send transactions (simulate mode)
      originalSendTransactions = process.env.SEND_TRANSACTIONS;
      process.env.SEND_TRANSACTIONS = "false";

      // Create a proper EVM client using MockSpokePool contract
      const [deployer] = await ethers.getSigners();
      const spokePool = await (await getContractFactory("MockSpokePool", deployer)).deploy(ZERO_ADDRESS);
      const evmSpokePoolClient = new clients.EVMSpokePoolClient(
        spyLogger,
        spokePool,
        hubPoolClient, // hubPoolClient
        1, // chainId
        0, // deploymentBlock
        { from: 0 } // eventSearchConfig
      );

      const l2SpokePoolClient = await clients.SVMSpokePoolClient.create(
        spyLogger,
        hubPoolClient,
        5, // chainId
        0n, // deploymentBlock
        { from: 0 },
        createDefaultSolanaClient().rpc // eventSearchConfig
      );

      // Call the finalizer
      const result: FinalizerPromise = await cctpL1toL2Finalizer(
        spyLogger,
        hubPoolClient.hubPool.signer, // Use a proper Wallet for testing
        hubPoolClient as any, // Cast to local HubPoolClient type
        l2SpokePoolClient,
        evmSpokePoolClient,
        ["0x1234567890123456789012345678901234567890"] as any
      );

      // Verify the result structure
      expect(result).to.have.property("crossChainMessages");
      expect(result).to.have.property("callData");
      expect(result.crossChainMessages).to.be.an("array");
      expect(result.callData).to.be.an("array");
      expect(result.crossChainMessages).to.have.length(0);
      expect(result.callData).to.have.length(0);
    } finally {
      if (originalSendTransactions !== undefined) {
        process.env.SEND_TRANSACTIONS = originalSendTransactions;
      }
    }
  });

  it("should handle mixed deposit and tokenless messages", async () => {
    // Create mixed messages (deposit + tokenless)
    const depositMessage = await getAttestedMessage(encodePauseDepositsMessageBody(true), 201, 0, 5);
    const tokenlessMessage = await getAttestedMessage(encodePauseDepositsMessageBody(false), 202, 0, 5);

    // Mock deposit message to have amount property (casting to any to add properties)
    (depositMessage[0] as any).amount = "1000000"; // 1 USDC in wei
    (depositMessage[0] as any).type = "transfer";

    const mixedMessages = [...depositMessage, ...tokenlessMessage];

    sinon.stub(CCTPUtils, "getAttestedCCTPMessages").resolves(mixedMessages);
    sinon.stub(CCTPUtils, "getCctpMessageTransmitter").returns({
      address: "CCTPmbSD7gX1bxKPAmg77w8oFzNFpaQiQUWD43TKaecd",
    });
    sinon.stub(svmSignerUtils, "getKitKeypairFromEvmSigner").resolves(signer);

    let originalSendTransactions: string | undefined;
    try {
      // Set environment to not send transactions (simulate mode)
      originalSendTransactions = process.env.SEND_TRANSACTIONS;
      process.env.SEND_TRANSACTIONS = "false";

      // Create a proper EVM client using MockSpokePool contract
      const [deployer] = await ethers.getSigners();
      const spokePool = await (await getContractFactory("MockSpokePool", deployer)).deploy(ZERO_ADDRESS);
      const evmSpokePoolClient = new clients.EVMSpokePoolClient(
        spyLogger,
        spokePool,
        hubPoolClient, // hubPoolClient
        1, // chainId
        0, // deploymentBlock
        { from: 0 } // eventSearchConfig
      );

      // Create a proper l2SpokePoolClient for Solana
      const l2SpokePoolClient = await clients.SVMSpokePoolClient.create(
        spyLogger,
        hubPoolClient,
        5, // chainId
        0n, // deploymentBlock
        { from: 0 },
        createDefaultSolanaClient().rpc // eventSearchConfig
      );

      // Call the finalizer
      const result: FinalizerPromise = await cctpL1toL2Finalizer(
        spyLogger,
        hubPoolClient.hubPool.signer, // Use a proper Wallet for testing
        hubPoolClient as any, // Cast to local HubPoolClient type
        l2SpokePoolClient,
        evmSpokePoolClient,
        ["0x1234567890123456789012345678901234567890"] as any
      );

      // Verify the result structure
      expect(result).to.have.property("crossChainMessages");
      expect(result).to.have.property("callData");
      expect(result.crossChainMessages).to.be.an("array");
      expect(result.callData).to.be.an("array");
      expect(result.crossChainMessages).to.have.length(0);
      expect(result.callData).to.have.length(0);
    } finally {
      if (originalSendTransactions !== undefined) {
        process.env.SEND_TRANSACTIONS = originalSendTransactions;
      }
    }
  });
});
