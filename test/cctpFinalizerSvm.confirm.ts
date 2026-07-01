import { expect } from "./utils";
import {
  createTransactionMessage,
  generateKeyPairSigner,
  pipe,
  setTransactionMessageFeePayerSigner,
  type Blockhash,
} from "@solana/kit";
import { sendAndConfirmSolanaTransaction } from "../src/utils/TransactionUtils";
import { sendAndConfirmMintOrThrow } from "../src/cctp-finalizer/utils/svmUtils";

// A 32-byte all-zero base58 string is a valid Blockhash shape for offline signing.
const FAKE_BLOCKHASH = "11111111111111111111111111111111" as Blockhash;

const buildSignableTx = async () => {
  const signer = await generateKeyPairSigner();
  return pipe(createTransactionMessage({ version: 0 }), (tx) => setTransactionMessageFeePayerSigner(signer, tx));
};

// Fake provider whose getSignatureStatuses always yields `statusValue` — used to
// simulate a dropped tx (status stays null / never reaches confirmed).
const makeFakeProvider = (statusValue: unknown) => {
  const fakeSignature = "5tkH59X6n7zVJ4r3z2hG5L9rA1bC2dE4fG6h8jK0mN1pQ3sT5uV7wY9aB1cD3eF6";
  return {
    provider: {
      getLatestBlockhash: () => ({
        send: async () => ({ value: { blockhash: FAKE_BLOCKHASH, lastValidBlockHeight: 1_000n } }),
      }),
      sendTransaction: () => ({ send: async () => fakeSignature }),
      getSignatureStatuses: () => ({ send: async () => ({ context: { slot: 0n }, value: [statusValue] }) }),
    },
    fakeSignature,
  };
};

describe("cctp-finalizer svmUtils — mint confirmation guard", function () {
  // Documents the root cause: the shared helper resolves with a signature even
  // when the tx never confirmed (a dropped tx), which is what caused the
  // finalizer to ack the Pub/Sub message prematurely.
  it("root cause: sendAndConfirmSolanaTransaction resolves even when the tx is never confirmed", async function () {
    const tx = await buildSignableTx();
    const { provider, fakeSignature } = makeFakeProvider(null); // dropped: status is always null
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sig = await sendAndConfirmSolanaTransaction(tx as any, provider as any, 2, 1);
    expect(sig).to.equal(fakeSignature);
  });

  it("throws when the mint tx is never confirmed (dropped)", async function () {
    const tx = await buildSignableTx();
    const { provider } = makeFakeProvider(null); // dropped: status is always null
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await expect(sendAndConfirmMintOrThrow(tx as any, provider as any, 2, 1)).to.be.rejectedWith(/not confirmed/);
  });

  it("returns the signature when the mint tx confirms", async function () {
    const tx = await buildSignableTx();
    const { provider, fakeSignature } = makeFakeProvider({
      confirmationStatus: "confirmed",
      slot: 123n,
      err: null,
      confirmations: 1n,
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sig = await sendAndConfirmMintOrThrow(tx as any, provider as any, 2, 1);
    expect(sig).to.equal(fakeSignature);
  });
});
