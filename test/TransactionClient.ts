import { AugmentedTransaction } from "../src/clients";
import { _selectNonce } from "../src/clients/TransactionClient";
import {
  BigNumber,
  ethers,
  isDefined,
  Provider,
  TransactionReceipt,
  TransactionResponse,
  TransactionSimulationResult,
} from "../src/utils";
import { CHAIN_ID_TEST_LIST as chainIds } from "./constants";
import { MockedTransactionClient, txnClientPassResult } from "./mocks/MockTransactionClient";
import { createSpyLogger, Contract, expect, randomAddress, toBN, winston, ethers as testEthers } from "./utils";

const { spyLogger }: { spyLogger: winston.Logger } = createSpyLogger();
const address = randomAddress(); // Test contract address
const method = "testMethod";
let txnClient: MockedTransactionClient;
let signer;

describe("TransactionClient", function () {
  beforeEach(async function () {
    txnClient = new MockedTransactionClient(spyLogger);
    [signer] = await testEthers.getSigners();
  });

  it("Correctly excludes simulation failures", async function () {
    for (const result of ["Forced simulation failure", txnClientPassResult]) {
      const fail = result !== txnClientPassResult;
      const txns: AugmentedTransaction[] = chainIds.map((_chainId) => {
        const chainId = Number(_chainId);
        return {
          chainId: chainId,
          contract: { address },
          args: [{ result }],
          message: `Test transaction on chain ${chainId}`,
          mrkdwn: `This transaction is expected to ${fail ? "fail" : "pass"} simulation.`,
        } as AugmentedTransaction;
      });

      expect(txns.length).to.equal(chainIds.length);
      const results: TransactionSimulationResult[] = await txnClient.simulate(txns);
      expect(results.length).to.equal(txns.length);

      // Verify that the failed simulations were filtered out.
      expect(results.filter((txn) => txn.succeed).length).to.equal(fail ? 0 : txns.length);
      expect(results.filter((txn) => !txn.succeed).length).to.equal(fail ? txns.length : 0);
    }
  });

  it("Handles submission success & failure", async function () {
    const chainId = chainIds[0];

    const nTxns = 4;
    const txns: AugmentedTransaction[] = [];
    for (const result of [txnClientPassResult, "Forced submission failure", txnClientPassResult]) {
      const txn: AugmentedTransaction = {
        chainId,
        contract: { address, signer } as Contract,
        method,
        args: [{ result }],
        value: toBN(0),
        mrkdwn: `Sample markdown string for chain ${chainId} transaction`,
      } as AugmentedTransaction;

      for (let nTxn = 1; nTxn <= nTxns; ++nTxn) {
        const message = `Test transaction (${nTxn}/${nTxns}) on chain ${chainId}`;
        txns.push({ ...txn, message } as AugmentedTransaction);
      }
    }

    // Should have 4 txn responses before the first bad transaction.
    let txnResponses: TransactionResponse[];
    txnResponses = await txnClient.submit(chainId, txns);
    expect(txnResponses.length).to.equal(nTxns);

    // Skip over the bad txns in the middle; all should pass.
    txnResponses = await txnClient.submit(chainId, txns.slice(0, nTxns).concat(txns.slice(-nTxns)));
    expect(txnResponses.length).to.equal(2 * nTxns);

    // The bad txns in the middle should exclusively fail.
    txnResponses = await txnClient.submit(chainId, txns.slice(nTxns, nTxns + nTxns));
    expect(txnResponses.length).to.equal(0);
  });

  it("Validates that successive transactions increment their nonce", async function () {
    const chainId = chainIds[0];

    const nTxns = 10;
    const txns: AugmentedTransaction[] = [];
    for (let txn = 1; txn <= nTxns; ++txn) {
      const txnRequest: AugmentedTransaction = {
        chainId,
        contract: { address, signer } as Contract,
        method,
        args: [],
        message: "",
        mrkdwn: "",
      };
      txns.push(txnRequest);
    }

    const txnResponses: TransactionResponse[] = await txnClient.submit(chainId, txns);
    let nonce = txnResponses[0].nonce;
    txnResponses.slice(1).forEach((txnResponse) => expect(txnResponse.nonce).to.equal(++nonce));
  });

  it("Transaction simulation result includes gasLimit", async function () {
    const chainId = chainIds[0];

    const nTxns = 10;
    const txns: AugmentedTransaction[] = [];
    for (let txn = 1; txn <= nTxns; ++txn) {
      const txnRequest: AugmentedTransaction = {
        chainId,
        contract: { address, signer } as Contract,
        method,
        args: [],
        message: "",
        mrkdwn: "",
      };
      txns.push(txnRequest);
    }
    const simResults = await txnClient.simulate([txns[0]]);
    const gasLimit = simResults[0]?.transaction?.gasLimit;
    expect(isDefined(gasLimit)).to.be.true;
    expect((gasLimit as BigNumber).gt(0)).to.be.true;
  });

  it("Transaction submission applies gasLimitMultiplier", async function () {
    const chainId = chainIds[0];
    const gasLimit = txnClient.randomGasLimit();

    const nTxns = 10;
    const txns: AugmentedTransaction[] = [];
    for (let txn = 1; txn <= nTxns; ++txn) {
      const txnRequest: AugmentedTransaction = {
        chainId,
        contract: { address, signer } as Contract,
        method,
        args: [],
        gasLimit,
        gasLimitMultiplier: txn, // number
        message: "",
        mrkdwn: "",
      };
      txns.push(txnRequest);
    }

    const txnResponses = await txnClient.submit(chainId, txns);
    txnResponses.forEach((txnResponse, idx) => {
      expect(txnResponse.gasLimit).to.equal(gasLimit.mul(idx + 1));
    });
  });

  describe("ensureConfirmation", function () {
    // The subset of Provider consumed by the confirmation loop.
    type MockProvider = Partial<Pick<ethers.providers.Provider, "getBlockNumber" | "getTransactionCount">>;

    function makeEthersError(code: string, extra: Record<string, unknown> = {}): Error {
      return Object.assign(new Error(code), { code, reason: code, ...extra });
    }

    function makeConfirmationTxn(chainId: number, provider?: MockProvider): AugmentedTransaction {
      return {
        chainId,
        // A static block number satisfies the confirmation baseline; timeout tests override it.
        contract: {
          address,
          signer,
          provider: { getBlockNumber: () => Promise.resolve(100), ...provider },
        } as Contract,
        method,
        args: [],
        message: "",
        mrkdwn: "",
        ensureConfirmation: true,
      };
    }

    class CountingClient extends MockedTransactionClient {
      public submissions = 0;
      protected override _getTransactionPromise(
        txn: AugmentedTransaction,
        nonce: number | null
      ): Promise<TransactionResponse> {
        ++this.submissions;
        return super._getTransactionPromise(txn, nonce);
      }
    }

    it("Confirms transaction receipt on success", async function () {
      const chainId = chainIds[0];
      let waitCalls = 0;
      txnClient.waitOverride = () => {
        ++waitCalls;
        return Promise.resolve({} as TransactionReceipt);
      };

      const txnResponses = await txnClient.submit(chainId, [makeConfirmationTxn(chainId)]);
      expect(txnResponses.length).to.equal(1);
      expect(waitCalls).to.equal(1);
    });

    it("Throws on CALL_EXCEPTION", async function () {
      const chainId = chainIds[0];
      txnClient.waitOverride = () => {
        return Promise.reject(makeEthersError(ethers.errors.CALL_EXCEPTION));
      };

      const txnResponses = await txnClient.submit(chainId, [makeConfirmationTxn(chainId)]);
      expect(txnResponses.length).to.equal(0);
    });

    it("Resubmits on TRANSACTION_REPLACED", async function () {
      const chainId = chainIds[0];
      let waitCalls = 0;
      txnClient.waitOverride = () => {
        if (++waitCalls === 1) {
          return Promise.reject(makeEthersError(ethers.errors.TRANSACTION_REPLACED));
        }
        return Promise.resolve({} as TransactionReceipt);
      };

      const txnResponses = await txnClient.submit(chainId, [makeConfirmationTxn(chainId)]);
      expect(txnResponses.length).to.equal(1);
      // First call rejected with TRANSACTION_REPLACED, _submit recursed, second call succeeded.
      expect(waitCalls).to.equal(2);
    });

    it("Adopts a repriced replacement instead of resubmitting", async function () {
      const chainId = chainIds[0];
      const replacement = { hash: ethers.utils.id("repriced"), nonce: 1 } as TransactionResponse;
      txnClient.waitOverride = () => {
        return Promise.reject(
          makeEthersError(ethers.errors.TRANSACTION_REPLACED, {
            reason: "repriced",
            receipt: { status: 1, blockNumber: 100 } as TransactionReceipt,
            replacement,
          })
        );
      };

      // A mined transaction with identical calldata (i.e. our own raced resubmission) is adopted.
      const txnResponses = await txnClient.submit(chainId, [makeConfirmationTxn(chainId)]);
      expect(txnResponses.length).to.equal(1);
      expect(txnResponses[0].hash).to.equal(replacement.hash);
    });

    it("Resubmits on confirmation timeout", async function () {
      const chainId = chainIds[0];
      // Seed the nonce cache so a pinned resubmission (nonce 42) is distinguishable from a
      // re-synced one (the mock defaults to nonce 1).
      const nonce = 42;
      txnClient.noncesBySigner[chainId] = { [await signer.getAddress()]: nonce - 1 };
      let blockNumber = 100;
      const provider: MockProvider = {
        getBlockNumber: () => Promise.resolve((blockNumber += 2)), // Blocks are produced without inclusion.
        getTransactionCount: () => Promise.resolve(nonce),
      };

      let waitCalls = 0;
      txnClient.waitOverride = () => {
        if (++waitCalls === 1) {
          return Promise.reject(makeEthersError(ethers.errors.TIMEOUT));
        }
        return Promise.resolve({} as TransactionReceipt);
      };

      const txnResponses = await txnClient.submit(chainId, [makeConfirmationTxn(chainId, provider)]);
      expect(txnResponses.length).to.equal(1);
      expect(waitCalls).to.equal(2);
      // The resubmission must pin the original nonce in order to replace the stuck transaction.
      expect(txnResponses[0].nonce).to.equal(nonce);
    });

    it("Tolerates transient RPC errors while confirming", async function () {
      const chainId = chainIds[0];
      const client = new CountingClient(spyLogger);

      // The baseline read and the first timeout probe fail transiently; neither must be
      // classified as a submission failure (the transaction is live).
      let [blockCalls, countCalls, waitCalls] = [0, 0, 0];
      let blockNumber = 100;
      const provider: MockProvider = {
        getBlockNumber: () =>
          ++blockCalls === 1 ? Promise.reject(new Error("rpc error")) : Promise.resolve((blockNumber += 2)),
        getTransactionCount: () => (++countCalls === 1 ? Promise.reject(new Error("rpc error")) : Promise.resolve(0)),
      };
      client.waitOverride = () => {
        return ++waitCalls <= 3
          ? Promise.reject(makeEthersError(ethers.errors.TIMEOUT))
          : Promise.resolve({} as TransactionReceipt);
      };

      const txnResponses = await client.submit(chainId, [makeConfirmationTxn(chainId, provider)]);
      expect(txnResponses.length).to.equal(1);
      // Failed baseline ⇒ baseline on the first successful probe, then one block-gate deferral,
      // then replacement.
      expect(client.submissions).to.equal(2);
      expect(waitCalls).to.equal(4);
    });

    it("Verifies the outcome when the nonce was consumed before replacement", async function () {
      const chainId = chainIds[0];
      const client = new CountingClient(spyLogger);
      const provider: MockProvider = { getTransactionCount: () => Promise.resolve(2) };
      let waitCalls = 0;
      client.waitOverride = () => {
        return ++waitCalls === 1
          ? Promise.reject(makeEthersError(ethers.errors.TIMEOUT))
          : Promise.resolve({} as TransactionReceipt);
      };

      // The original (mock nonce 1) was mined during the timeout; verify it, don't resubmit.
      const txnResponses = await client.submit(chainId, [makeConfirmationTxn(chainId, provider)]);
      expect(txnResponses.length).to.equal(1);
      expect(client.submissions).to.equal(1);
      expect(waitCalls).to.equal(2);
    });

    it("Defers replacement until blocks are produced", async function () {
      const chainId = chainIds[0];
      const client = new CountingClient(spyLogger);
      const provider: MockProvider = { getTransactionCount: () => Promise.resolve(0) };
      let waitCalls = 0;
      client.waitOverride = () => {
        return ++waitCalls <= 2
          ? Promise.reject(makeEthersError(ethers.errors.TIMEOUT))
          : Promise.resolve({} as TransactionReceipt);
      };

      // The static block number simulates a chain producing no blocks: timeouts alone must not
      // trigger replacement.
      const txnResponses = await client.submit(chainId, [makeConfirmationTxn(chainId, provider)]);
      expect(txnResponses.length).to.equal(1);
      expect(client.submissions).to.equal(1);
      expect(waitCalls).to.equal(3);
    });

    it("Gives up after timeout resubmissions exhausted", async function () {
      const chainId = chainIds[0];
      let blockNumber = 100;
      const provider: MockProvider = {
        getBlockNumber: () => Promise.resolve((blockNumber += 2)),
        getTransactionCount: () => Promise.resolve(0),
      };
      let waitCalls = 0;
      txnClient.waitOverride = () => {
        ++waitCalls;
        return Promise.reject(makeEthersError(ethers.errors.TIMEOUT));
      };

      // Confirmation failure is alerted via error-level log; the response is still returned.
      const txnResponses = await txnClient.submit(chainId, [makeConfirmationTxn(chainId, provider)]);
      expect(txnResponses.length).to.equal(1);
      // Initial submission + one resubmission per remaining maxTries (default is 10).
      expect(waitCalls).to.equal(11);
    });

    it("Retries on transient error then succeeds", async function () {
      const chainId = chainIds[0];
      let waitCalls = 0;
      txnClient.waitOverride = () => {
        if (++waitCalls === 1) {
          return Promise.reject(makeEthersError(ethers.errors.SERVER_ERROR));
        }
        return Promise.resolve({} as TransactionReceipt);
      };

      const txnResponses = await txnClient.submit(chainId, [makeConfirmationTxn(chainId)]);
      expect(txnResponses.length).to.equal(1);
      expect(waitCalls).to.equal(2);
    });

    it("Gives up after maxTries exhausted", async function () {
      const chainId = chainIds[0];
      let waitCalls = 0;
      txnClient.waitOverride = () => {
        ++waitCalls;
        return Promise.reject(makeEthersError(ethers.errors.SERVER_ERROR));
      };

      const txnResponses = await txnClient.submit(chainId, [makeConfirmationTxn(chainId)]);
      // The transaction still returns because _submit returns txnPromise even when confirmation fails.
      expect(txnResponses.length).to.equal(1);
      // wait() was called maxTries times (default is 10).
      expect(waitCalls).to.equal(10);
    });
  });

  describe("_selectNonce", function () {
    const backlogThreshold = 4;
    const chainId = chainIds[0];
    // The replaced-head marker is keyed by chain and signer, so isolate each test with a fresh
    // signer address.
    let signerAddr: string;

    beforeEach(function () {
      signerAddr = randomAddress();
    });

    function makeProvider(confirmed: number, pending?: number): Provider {
      return {
        getTransactionCount: (_address: string, blockTag?: string) =>
          blockTag === "pending"
            ? isDefined(pending)
              ? Promise.resolve(pending)
              : Promise.reject(new Error("pending tag unsupported"))
            : Promise.resolve(confirmed),
      } as unknown as Provider;
    }

    it("Appends behind a modest in-flight backlog", async function () {
      const { nonce, replacing } = await _selectNonce(chainId, makeProvider(10, 13), signerAddr, backlogThreshold);
      expect(nonce).to.equal(13);
      expect(replacing).to.be.false;
    });

    it("Replaces at the confirmed nonce at/beyond the backlog threshold", async function () {
      const { nonce, replacing } = await _selectNonce(chainId, makeProvider(10, 14), signerAddr, backlogThreshold);
      expect(nonce).to.equal(10);
      expect(replacing).to.be.true;
    });

    it("Falls back to replacement mode when the pending tag is unsupported", async function () {
      // The backlog is unknowable, so an occupied confirmed nonce must escalate fees at the same
      // nonce (replacement mode) rather than futilely re-selecting the same nonce.
      const { nonce, replacing } = await _selectNonce(chainId, makeProvider(10), signerAddr, backlogThreshold);
      expect(nonce).to.equal(10);
      expect(replacing).to.be.true;
    });

    it("Clamps an inconsistent pending count", async function () {
      const { nonce, replacing } = await _selectNonce(chainId, makeProvider(10, 8), signerAddr, backlogThreshold);
      expect(nonce).to.equal(10);
      expect(replacing).to.be.false;
    });

    it("Targets a deep-backlog head only once", async function () {
      const provider = makeProvider(10, 14);
      let selected = await _selectNonce(chainId, provider, signerAddr, backlogThreshold);
      expect(selected.nonce).to.equal(10);
      expect(selected.replacing).to.be.true;

      // Replacement leaves the backlog depth unchanged; the head must not be re-targeted (that
      // would evict the just-submitted replacement), so subsequent selections append instead.
      selected = await _selectNonce(chainId, provider, signerAddr, backlogThreshold);
      expect(selected.nonce).to.equal(14);
      expect(selected.replacing).to.be.false;
    });

    it("Re-arms replacement when the queue head advances", async function () {
      let selected = await _selectNonce(chainId, makeProvider(10, 14), signerAddr, backlogThreshold);
      expect(selected.nonce).to.equal(10);
      expect(selected.replacing).to.be.true;

      // The prior head confirmed but the backlog is still deep; the new head is fair game.
      selected = await _selectNonce(chainId, makeProvider(11, 15), signerAddr, backlogThreshold);
      expect(selected.nonce).to.equal(11);
      expect(selected.replacing).to.be.true;
    });
  });

  describe("Cached nonce reconciliation", function () {
    function makeTxn(chainId: number, confirmedCount: number, pendingCount: number): AugmentedTransaction {
      const provider = {
        getTransactionCount: (_address: string, blockTag?: string) =>
          Promise.resolve(blockTag === "pending" ? pendingCount : confirmedCount),
      };
      return {
        chainId,
        contract: { address, signer, provider } as unknown as Contract,
        method,
        args: [],
        message: "",
        mrkdwn: "",
      } as AugmentedTransaction;
    }

    it("Appends behind nonces occupied by a concurrent submitter", async function () {
      const chainId = chainIds[0];
      // Cached: this client last submitted nonce 9, so the naive next nonce is 10.
      txnClient.noncesBySigner[chainId] = { [await signer.getAddress()]: 9 };

      // A concurrent submitter sharing the signer occupied nonces 10-12 (modest backlog).
      const [txnResponse] = await txnClient.submit(chainId, [makeTxn(chainId, 10, 13)]);
      expect(txnResponse.nonce).to.equal(13);
    });

    it("Retains a cached nonce that leads the pending transaction count", async function () {
      const chainId = chainIds[0];
      txnClient.noncesBySigner[chainId] = { [await signer.getAddress()]: 9 };

      // The provider's pending count lags this client's own submissions; trust the cache.
      const [txnResponse] = await txnClient.submit(chainId, [makeTxn(chainId, 8, 8)]);
      expect(txnResponse.nonce).to.equal(10);
    });

    it("Adopts a deep-backlog replacement over the cached nonce", async function () {
      // Isolate the replaced-head marker: this test must not share (chainId, signer) with others.
      const chainId = chainIds[1];
      txnClient.noncesBySigner[chainId] = { [await signer.getAddress()]: 12 };

      // Backlog of 5 (>= threshold 4): the stuck head at nonce 10 is targeted for replacement
      // rather than appending at the cached nonce 13 (or the pending nonce 15) behind it.
      const [txnResponse] = await txnClient.submit(chainId, [makeTxn(chainId, 10, 15)]);
      expect(txnResponse.nonce).to.equal(10);
    });

    it("Appends behind the backlog tail after replacing its head", async function () {
      // Isolate the replaced-head marker: this test must not share (chainId, signer) with others.
      const chainId = chainIds[2];
      txnClient.noncesBySigner[chainId] = { [await signer.getAddress()]: 12 };

      // The first transaction replaces the stuck head at nonce 10, resetting the nonce cache to
      // the head. Nonces 11-14 are still occupied by the in-flight backlog, so the second
      // transaction must append at the observed tail (15) — not head + 1, which would evict a
      // queued transaction given a sufficiently higher fee quote.
      const txns = [makeTxn(chainId, 10, 15), makeTxn(chainId, 10, 15)];
      const txnResponses = await txnClient.submit(chainId, txns);
      expect(txnResponses.map(({ nonce }) => nonce)).to.deep.equal([10, 15]);
    });

    it("Reconciles the second submission when the first started cold", async function () {
      const chainId = chainIds[0];
      // No cached nonce: the first transaction selects inside _runTransaction (mocked here to
      // nonce 1), which must not mark the signer reconciled. The second transaction then
      // reconciles its warm cache (2) against the pending count (5) and appends behind it.
      const txns = [makeTxn(chainId, 2, 5), makeTxn(chainId, 2, 5)];
      const txnResponses = await txnClient.submit(chainId, txns);
      expect(txnResponses.map(({ nonce }) => nonce)).to.deep.equal([1, 5]);
    });
  });
});
