import { expect } from "./utils";
import {
  createTransactionMessage,
  generateKeyPairSigner,
  pipe,
  setTransactionMessageFeePayerSigner,
  type Blockhash,
} from "@solana/kit";
import {
  sendAndConfirmSolanaTransaction,
  sendAndConfirmSolanaTransactionWithSlot,
} from "../src/utils/TransactionUtils";

// A 32-byte all-zero base58 string is a valid Blockhash shape for offline
// signing in tests. Using a fixed value keeps the test deterministic without
// requiring a running validator.
const FAKE_BLOCKHASH = "11111111111111111111111111111111" as Blockhash;

type CapturedSendOptions = { minContextSlot?: bigint } & Record<string, unknown>;

const buildSignableTx = async () => {
  const signer = await generateKeyPairSigner();
  const txMessage = pipe(createTransactionMessage({ version: 0 }), (tx) =>
    setTransactionMessageFeePayerSigner(signer, tx)
  );
  return txMessage;
};

type FakeProviderOpts = {
  // If set, the Nth call to sendTransaction (1-indexed) throws instead of
  // returning a signature. Used to verify rebroadcast errors are swallowed.
  throwOnSendInvocation?: number;
};

const makeFakeProvider = (
  statusValueByPollCall: Array<unknown>,
  contextSlotByPollCall: Array<bigint> = [],
  providerOpts: FakeProviderOpts = {}
) => {
  const fakeSignature = "5tkH59X6n7zVJ4r3z2hG5L9rA1bC2dE4fG6h8jK0mN1pQ3sT5uV7wY9aB1cD3eF6";
  const sendInvocations: Array<CapturedSendOptions> = [];
  let pollIndex = 0;
  const provider = {
    getLatestBlockhash: () => ({
      send: async () => ({ value: { blockhash: FAKE_BLOCKHASH, lastValidBlockHeight: 1_000n } }),
    }),
    sendTransaction: (_serializedTx: string, opts: CapturedSendOptions) => {
      sendInvocations.push(opts);
      const thisCall = sendInvocations.length;
      return {
        send: async () => {
          if (providerOpts.throwOnSendInvocation === thisCall) {
            throw new Error("simulated RPC failure on rebroadcast");
          }
          return fakeSignature;
        },
      };
    },
    getSignatureStatuses: (_sigs: string[]) => ({
      send: async () => {
        const idx = Math.min(pollIndex++, statusValueByPollCall.length - 1);
        const contextSlot = contextSlotByPollCall[Math.min(idx, contextSlotByPollCall.length - 1)] ?? 0n;
        return {
          context: { slot: contextSlot },
          value: [statusValueByPollCall[idx]],
        };
      },
    }),
  };
  return { provider, sendInvocations, fakeSignature };
};

describe("TransactionUtils — SVM send pinning", function () {
  describe("sendAndConfirmSolanaTransactionWithSlot", function () {
    it("threads `minContextSlot` into sendTransaction options and returns the confirmed slot", async function () {
      const txMessage = await buildSignableTx();
      const { provider, sendInvocations, fakeSignature } = makeFakeProvider([
        { confirmationStatus: "confirmed", slot: 12_345n, err: null, confirmations: 1n },
      ]);

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = await sendAndConfirmSolanaTransactionWithSlot(txMessage as any, provider as any, 5, 1, {
        minContextSlot: 999n,
      });

      expect(result.signature).to.equal(fakeSignature);
      expect(result.confirmedSlot).to.equal(12_345n);
      expect(sendInvocations).to.have.lengthOf(1);
      expect(sendInvocations[0].minContextSlot).to.equal(999n);
      // The existing send options must still be set on every send for parity with the prior behavior.
      expect(sendInvocations[0].preflightCommitment).to.equal("confirmed");
      expect(sendInvocations[0].skipPreflight).to.equal(false);
    });

    it("omits `minContextSlot` from sendTransaction options when no opts are supplied", async function () {
      const txMessage = await buildSignableTx();
      const { provider, sendInvocations } = makeFakeProvider([
        { confirmationStatus: "confirmed", slot: 5n, err: null, confirmations: 1n },
      ]);

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await sendAndConfirmSolanaTransactionWithSlot(txMessage as any, provider as any, 5, 1);
      expect(sendInvocations[0].minContextSlot).to.equal(undefined);
    });

    it("falls back to the response `context.slot` when `entry.slot` is missing on confirmation", async function () {
      const txMessage = await buildSignableTx();
      const { provider } = makeFakeProvider(
        [{ confirmationStatus: "confirmed", slot: undefined, err: null, confirmations: 1n }],
        [54_321n]
      );

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = await sendAndConfirmSolanaTransactionWithSlot(txMessage as any, provider as any, 5, 1);
      expect(result.confirmedSlot).to.equal(54_321n);
    });

    it("returns `confirmedSlot=undefined` when confirmation never reaches confirmed/finalized", async function () {
      const txMessage = await buildSignableTx();
      const { provider } = makeFakeProvider([
        { confirmationStatus: "processed", slot: 1n, err: null, confirmations: 0n },
        { confirmationStatus: "processed", slot: 2n, err: null, confirmations: 0n },
      ]);

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = await sendAndConfirmSolanaTransactionWithSlot(txMessage as any, provider as any, 2, 1);
      expect(result.confirmedSlot).to.equal(undefined);
    });
  });

  describe("rebroadcast during polling", function () {
    it("does not rebroadcast when the tx confirms on the first poll", async function () {
      const txMessage = await buildSignableTx();
      const { provider, sendInvocations } = makeFakeProvider([
        { confirmationStatus: "confirmed", slot: 10n, err: null, confirmations: 1n },
      ]);

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await sendAndConfirmSolanaTransactionWithSlot(txMessage as any, provider as any, 10, 1);

      expect(sendInvocations).to.have.lengthOf(1);
      expect(sendInvocations[0].skipPreflight).to.equal(false);
    });

    it("rebroadcasts the same wire tx with skipPreflight=true every 3 polling cycles", async function () {
      const txMessage = await buildSignableTx();
      // 7 unconfirmed polls — cycle index after each poll is 1..7, so
      // rebroadcasts fire at cycle 3 and cycle 6 → 1 initial send + 2
      // rebroadcasts = 3 total sendTransaction invocations.
      const unconfirmed = Array.from({ length: 7 }, () => ({
        confirmationStatus: "processed",
        slot: 1n,
        err: null,
        confirmations: 0n,
      }));
      const { provider, sendInvocations } = makeFakeProvider(unconfirmed);

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = await sendAndConfirmSolanaTransactionWithSlot(txMessage as any, provider as any, 7, 1, {
        minContextSlot: 500n,
      });
      expect(result.confirmedSlot).to.equal(undefined);
      expect(sendInvocations).to.have.lengthOf(3);
      // Initial send keeps preflight on; rebroadcasts skip it.
      expect(sendInvocations[0].skipPreflight).to.equal(false);
      expect(sendInvocations[1].skipPreflight).to.equal(true);
      expect(sendInvocations[2].skipPreflight).to.equal(true);
      // Rebroadcasts preserve the same `minContextSlot` pin as the initial send.
      expect(sendInvocations[0].minContextSlot).to.equal(500n);
      expect(sendInvocations[1].minContextSlot).to.equal(500n);
      expect(sendInvocations[2].minContextSlot).to.equal(500n);
    });

    it("swallows errors thrown by the rebroadcast sendTransaction and keeps polling", async function () {
      const txMessage = await buildSignableTx();
      // Unconfirmed for cycles 1..3 then confirmed on poll 4 — exactly one
      // rebroadcast fires at cycle 3 and it throws.
      const statuses = [
        { confirmationStatus: "processed", slot: 1n, err: null, confirmations: 0n },
        { confirmationStatus: "processed", slot: 1n, err: null, confirmations: 0n },
        { confirmationStatus: "processed", slot: 1n, err: null, confirmations: 0n },
        { confirmationStatus: "confirmed", slot: 99n, err: null, confirmations: 1n },
      ];
      const { provider, sendInvocations } = makeFakeProvider(statuses, [], { throwOnSendInvocation: 2 });

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = await sendAndConfirmSolanaTransactionWithSlot(txMessage as any, provider as any, 10, 1);

      // 1 initial + 1 (failing) rebroadcast = 2 send invocations; the
      // rebroadcast error must not propagate, and polling must still observe
      // the eventual confirmation.
      expect(sendInvocations).to.have.lengthOf(2);
      expect(result.confirmedSlot).to.equal(99n);
    });
  });

  describe("sendAndConfirmSolanaTransaction (backwards-compat)", function () {
    it("still returns just a signature string and threads `minContextSlot` when supplied", async function () {
      const txMessage = await buildSignableTx();
      const { provider, sendInvocations, fakeSignature } = makeFakeProvider([
        { confirmationStatus: "finalized", slot: 7n, err: null, confirmations: 2n },
      ]);

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const sig = await sendAndConfirmSolanaTransaction(txMessage as any, provider as any, 5, 1, {
        minContextSlot: 42n,
      });
      expect(sig).to.equal(fakeSignature);
      expect(sendInvocations[0].minContextSlot).to.equal(42n);
    });
  });
});
