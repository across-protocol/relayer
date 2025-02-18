import { utils as sdkUtils } from "@across-protocol/sdk";
import {
  AugmentedTransaction,
  knownRevertReasons,
  unknownRevertReason,
  unknownRevertReasonMethodsToIgnore,
  unknownRevertReasons,
} from "../src/clients";
import { bnOne, BigNumber, TransactionSimulationResult } from "../src/utils";
import { MockedTransactionClient, txnClientPassResult } from "./mocks/MockTransactionClient";
import { CHAIN_ID_TEST_LIST as chainIds } from "./constants";
import { createSpyLogger, Contract, expect, randomAddress, winston, toBN, smock, assertPromiseError } from "./utils";
import { MockedMultiCallerClient } from "./mocks/MockMultiCallerClient";

class DummyMultiCallerClient extends MockedMultiCallerClient {
  public ignoredSimulationFailures: TransactionSimulationResult[] = [];
  public loggedSimulationFailures: TransactionSimulationResult[] = [];

  constructor(logger: winston.Logger, chunkSize: { [chainId: number]: number } = {}, public multisend?: Contract) {
    super(logger, chunkSize, multisend);
    this.txnClient = new MockedTransactionClient(logger);
  }

  simulationFailureCount(): number {
    return this.loggedSimulationFailures.length + this.ignoredSimulationFailures.length;
  }

  clearSimulationFailures(): void {
    this.ignoredSimulationFailures = [];
    this.loggedSimulationFailures = [];
  }

  private txnCount(txnQueue: { [chainId: number]: AugmentedTransaction[] }): number {
    return Object.values(txnQueue).reduce((count, txnQueue) => (count += txnQueue.length), 0);
  }

  nonMulticallTxnCount(): number {
    return this.txnCount(this.nonMulticallTxns);
  }

  multiCallTransactionCount(): number {
    return this.txnCount(this.txns);
  }

  protected override logSimulationFailures(txns: TransactionSimulationResult[]): void {
    this.clearSimulationFailures();
    txns.forEach((txn) => {
      (this.canIgnoreRevertReason(txn) ? this.ignoredSimulationFailures : this.loggedSimulationFailures).push(txn);
    });
  }
}

// encodeFunctionData is called from within MultiCallerClient.buildMultiCallBundle.
function encodeFunctionData(_method: string, args: ReadonlyArray<unknown> = []): string {
  return args.join(" ");
}

describe("MultiCallerClient", async function () {
  const { spyLogger }: { spyLogger: winston.Logger } = createSpyLogger();
  const address = randomAddress(); // Test contract address
  let multiCaller: DummyMultiCallerClient;

  beforeEach(async function () {
    multiCaller = new DummyMultiCallerClient(spyLogger);
    expect(multiCaller.transactionCount()).to.equal(0);
    expect(multiCaller.simulationFailureCount()).to.equal(0);
  });

  it("Correctly enqueues value transactions", async function () {
    chainIds.forEach((chainId) => multiCaller.enqueueTransaction({ chainId, value: toBN(1) } as AugmentedTransaction));
    expect(multiCaller.nonMulticallTxnCount()).to.equal(chainIds.length);
    expect(multiCaller.transactionCount()).to.equal(chainIds.length);
  });

  it("Correctly enqueues non-multicall transactions", async function () {
    chainIds.forEach((chainId) =>
      multiCaller.enqueueTransaction({ chainId, nonMulticall: true } as AugmentedTransaction)
    );
    expect(multiCaller.nonMulticallTxnCount()).to.equal(chainIds.length);
    expect(multiCaller.transactionCount()).to.equal(chainIds.length);
  });

  it("Correctly enqueues non-value transactions", async function () {
    [undefined, toBN(0)].forEach((value) => {
      multiCaller.clearTransactionQueue();
      expect(multiCaller.transactionCount()).to.equal(0);

      chainIds.forEach((chainId) => multiCaller.enqueueTransaction({ chainId, value } as AugmentedTransaction));
      expect(multiCaller.multiCallTransactionCount()).to.equal(chainIds.length);
      expect(multiCaller.transactionCount()).to.equal(chainIds.length);
    });
  });

  it("Correctly enqueues mixed transactions", async function () {
    chainIds.forEach((chainId) => {
      multiCaller.enqueueTransaction({ chainId } as AugmentedTransaction);
      multiCaller.enqueueTransaction({ chainId, value: bnOne } as AugmentedTransaction);
      multiCaller.enqueueTransaction({ chainId, nonMulticall: true } as AugmentedTransaction);
    });
    expect(multiCaller.multiCallTransactionCount()).to.equal(chainIds.length);
    expect(multiCaller.nonMulticallTxnCount()).to.equal(2 * chainIds.length);
    expect(multiCaller.transactionCount()).to.equal(3 * chainIds.length);
  });

  it("Propagates input transaction gasLimits: internal multicall", async function () {
    const fakeMultisender = await smock.fake(await sdkUtils.getABI("Multicall3"), { address: randomAddress() });
    multiCaller = new DummyMultiCallerClient(spyLogger, {}, fakeMultisender as unknown as Contract);

    const nTxns = 10;
    const gasLimit = toBN(99_999);

    const txns: AugmentedTransaction[] = [];
    for (let i = 0; i < nTxns; ++i) {
      const txn: AugmentedTransaction = {
        chainId: 1,
        contract: {
          address,
          interface: { encodeFunctionData },
        } as Contract,
        method: "gasLimitTest",
        args: [{ txnClientPassResult }],
        gasLimit,
        message: `Test transaction with gasLimit ${gasLimit}`,
        unpermissioned: true,
      };
      txns.push(txn);
    }

    const txnBundle = multiCaller.buildMultiCallBundle(txns)[0];
    expect(txnBundle.gasLimit).to.not.be.undefined;
    const _gasLimit = txnBundle.gasLimit as BigNumber;
    expect(_gasLimit.eq(gasLimit.mul(nTxns))).to.be.true;
  });

  it("Can revert to undefined gasLimit: internal multicall", async function () {
    const fakeMultisender = await smock.fake(await sdkUtils.getABI("Multicall3"), { address: randomAddress() });
    multiCaller = new DummyMultiCallerClient(spyLogger, {}, fakeMultisender as unknown as Contract);

    const nTxns = 10;
    const gasLimit = toBN(99_999);

    const txns: AugmentedTransaction[] = [];
    for (let i = 0; i < nTxns; ++i) {
      const txn: AugmentedTransaction = {
        chainId: 1,
        contract: {
          address,
          interface: { encodeFunctionData },
        } as Contract,
        method: "gasLimitTest",
        args: [{ txnClientPassResult }],
        gasLimit: i === nTxns - 1 ? undefined : gasLimit,
        message: `Test transaction with gasLimit ${gasLimit}`,
        unpermissioned: true,
      };
      txns.push(txn);
    }

    const txnBundle = multiCaller.buildMultiCallBundle(txns)[0];
    expect(txnBundle.gasLimit).to.be.undefined;
  });

  it("Propagates input transaction gasLimits: external multicall", async function () {
    const fakeMultisender = await smock.fake(await sdkUtils.getABI("Multicall3"), { address: randomAddress() });
    multiCaller = new DummyMultiCallerClient(spyLogger, {}, fakeMultisender as unknown as Contract);

    const nTxns = 10;
    const gasLimit = toBN(99_999);

    const txns: AugmentedTransaction[] = [];
    for (let i = 0; i < nTxns; ++i) {
      const txn: AugmentedTransaction = {
        chainId: 1,
        contract: {
          address,
          interface: { encodeFunctionData },
        } as Contract,
        method: "gasLimitTest",
        args: [{ txnClientPassResult }],
        gasLimit,
        message: `Test transaction with gasLimit ${gasLimit}`,
        unpermissioned: true,
      };
      txns.push(txn);
    }

    const txnBundle = await multiCaller.buildMultiSenderBundle(txns);
    expect(txnBundle.gasLimit).to.not.be.undefined;
    const _gasLimit = txnBundle.gasLimit as BigNumber;
    expect(_gasLimit.eq(gasLimit.mul(nTxns))).to.be.true;
  });

  it("Can revert to undefined gasLimit: external multicall", async function () {
    const fakeMultisender = await smock.fake(await sdkUtils.getABI("Multicall3"), { address: randomAddress() });
    multiCaller = new DummyMultiCallerClient(spyLogger, {}, fakeMultisender as unknown as Contract);

    const nTxns = 10;
    const gasLimit = toBN(99_999);

    const txns: AugmentedTransaction[] = [];
    for (let i = 0; i < nTxns; ++i) {
      const txn: AugmentedTransaction = {
        chainId: 1,
        contract: {
          address,
          interface: { encodeFunctionData },
        } as Contract,
        method: "gasLimitTest",
        args: [{ txnClientPassResult }],
        gasLimit: i === nTxns - 1 ? undefined : gasLimit,
        message: `Test transaction with gasLimit ${gasLimit}`,
        unpermissioned: true,
      };
      txns.push(txn);
    }

    const txnBundle = await multiCaller.buildMultiSenderBundle(txns);
    expect(txnBundle.gasLimit).to.be.undefined;
  });

  it("Correctly excludes simulation failures", async function () {
    for (const result of ["Forced simulation failure", txnClientPassResult]) {
      const fail = !(result === txnClientPassResult);
      const txns: AugmentedTransaction[] = chainIds.map((_chainId) => {
        const chainId = Number(_chainId);
        return {
          chainId,
          contract: { address },
          args: [{ result }],
          message: `Test transaction on chain ${chainId}`,
          mrkdwn: `This transaction is expected to ${fail ? "fail" : "pass"} simulation.`,
        } as AugmentedTransaction;
      });

      expect(txns.length).to.equal(chainIds.length);
      const results: AugmentedTransaction[] = await multiCaller.simulateTransactionQueue(txns);
      expect(results.length).to.equal(fail ? 0 : txns.length);

      // Verify that the failed simulations were filtered out.
      expect(multiCaller.simulationFailureCount()).to.equal(fail ? txns.length : 0);
      multiCaller.clearSimulationFailures();
    }
  });

  it("Handles submission success & failure", async function () {
    const nTxns = 4;
    for (const result of ["Forced submission failure", txnClientPassResult]) {
      const fail = !(result === txnClientPassResult);

      for (const value of [0, 1]) {
        const txnType = value > 0 ? "value" : "multicall";

        for (let txn = 1; txn <= nTxns; ++txn) {
          chainIds.forEach((_chainId) => {
            const chainId = Number(_chainId);
            const txnRequest: AugmentedTransaction = {
              chainId,
              contract: {
                address,
                interface: { encodeFunctionData },
                multicall: 1,
              } as unknown as Contract,
              method: "test",
              args: [{ result }],
              value: toBN(value),
              message: `Test ${txnType} transaction (${txn}/${nTxns}) on chain ${chainId}`,
              mrkdwn: `Sample markdown string for chain ${chainId} ${txnType} transaction`,
            };

            multiCaller.enqueueTransaction(txnRequest);
          });
        }
      }

      expect(multiCaller.transactionCount()).to.equal(nTxns * 2 * chainIds.length);

      // Note: Half of the txns should be consolidated into a single multicall txn.
      const results = await multiCaller.executeTxnQueues();
      expect(Object.values(results).flat().length).to.equal(fail ? 0 : (nTxns + 1) * chainIds.length);
    }
  });

  it("Submits non-multicall txns", async function () {
    const nTxns = 3;
    for (let txn = 1; txn <= nTxns; ++txn) {
      const chainId = chainIds[0];
      const txnRequest: AugmentedTransaction = {
        chainId,
        contract: {
          address,
          interface: { encodeFunctionData },
          multicall: 1,
        } as unknown as Contract,
        method: "test",
        args: [{ result: txnClientPassResult }],
        nonMulticall: true,
        message: `Test nonMulticall transaction (${txn}/${nTxns}) on chain ${chainId}`,
        mrkdwn: `Sample markdown string for chain ${chainId} transaction`,
      };

      multiCaller.enqueueTransaction(txnRequest);
    }
    expect(multiCaller.transactionCount()).to.equal(nTxns);

    // Should have nTxns since non-multicall txns are not batched.
    const results = await multiCaller.executeTxnQueues();
    expect(Object.values(results).flat().length).to.equal(nTxns);
  });

  it("Correctly filters loggable vs. ignorable simulation failures", async function () {
    const txn = {
      chainId: chainIds[0],
      contract: { address },
    } as AugmentedTransaction;

    // Verify that all known revert reasons are ignored.
    for (const revertReason of knownRevertReasons) {
      txn.args = [{ result: revertReason }];
      txn.message = `Transaction simulation failure; expected to fail with: ${revertReason}.`;

      const result = await multiCaller.simulateTransactionQueue([txn]);
      expect(result.length).to.equal(0);
      expect(multiCaller.ignoredSimulationFailures.length).to.equal(1);
      expect(multiCaller.loggedSimulationFailures.length).to.equal(0);
    }

    // Verify that the defined "unknown" revert reason against known methods is ignored.
    for (const unknownRevertReason of unknownRevertReasons) {
      txn.args = [{ result: unknownRevertReason }];
      for (const method of unknownRevertReasonMethodsToIgnore) {
        txn.method = method;
        txn.message = `${txn.method} simulation; expected to fail with: ${unknownRevertReason}.`;

        const result = await multiCaller.simulateTransactionQueue([txn]);
        expect(result.length).to.equal(0);
        expect(multiCaller.ignoredSimulationFailures.length).to.equal(1);
        expect(multiCaller.loggedSimulationFailures.length).to.equal(0);
      }
    }

    // Verify that unexpected revert reason against both known and "unknown" methods are logged.
    for (const method of [...unknownRevertReasonMethodsToIgnore, "randomMethod"]) {
      txn.method = method;

      for (const revertReason of ["unexpected revert reasons", "should not be ignored!"]) {
        txn.args = [{ result: revertReason }];
        txn.message = `${txn.method} simulation; expected to fail with: ${unknownRevertReason}.`;

        const result = await multiCaller.simulateTransactionQueue([txn]);
        expect(result.length).to.equal(0);
        expect(multiCaller.ignoredSimulationFailures.length).to.equal(0);
        expect(multiCaller.loggedSimulationFailures.length).to.equal(1);
      }
    }
  });

  it("Validates transaction data before multicall bundle generation", async function () {
    const chainId = chainIds[0];

    for (const badField of ["address", "chainId"]) {
      const txns: AugmentedTransaction[] = [];

      for (let i = 0; i < 5; ++i) {
        const txn: AugmentedTransaction = {
          chainId,
          contract: {
            address,
            interface: { encodeFunctionData },
          } as Contract,
          method: "test",
          args: ["2"],
          value: toBN(0),
          message: `Test multicall candidate on chain ${chainId}`,
          mrkdwn: "",
        };
        txns.push(txn);
      }

      expect(txns.length).to.not.equal(0);
      expect(() => multiCaller._buildMultiCallBundle(txns)).to.not.throw();

      const badTxn = txns.pop() as AugmentedTransaction;
      switch (badField) {
        case "address":
          badTxn.contract = {
            address: randomAddress(),
            interface: { encodeFunctionData },
          } as Contract;
          break;

        case "chainId":
          badTxn.chainId += 1;
          break;
      }

      txns.push(badTxn);
      expect(() => multiCaller._buildMultiCallBundle(txns)).to.throw("Multicall bundle data mismatch");
    }
  });

  it("buildMultiCallBundle can handle transactions to different target contracts", async function () {
    const chainId = chainIds[0];
    const txns = [
      {
        chainId: chainId,
        contract: {
          address,
          interface: { encodeFunctionData },
        } as Contract,
        method: "test3",
        args: ["3"],
        value: toBN(1),
        message: `Test3 multicall candidate on chain ${chainId}`,
      },
      {
        chainId: chainId,
        contract: {
          address,
          interface: { encodeFunctionData },
        } as Contract,
        method: "test2",
        args: ["2"],
        value: toBN(0),
        message: `Test2 multicall candidate on chain ${chainId}`,
      },
      {
        chainId: chainId,
        contract: {
          address: randomAddress(),
          interface: { encodeFunctionData },
        } as Contract,
        method: "test1",
        args: ["1"],
        message: `Test1 multicall candidate on chain ${chainId}`,
      },
    ] as AugmentedTransaction[];

    // Should return one AugmentedTransaction per unique target, so two in total.
    expect(() => multiCaller.buildMultiCallBundle(txns)).to.not.throw();
    expect(multiCaller.buildMultiCallBundle(txns).length).to.equal(2);
  });

  it("Respects multicall bundle chunk size configurations", async function () {
    const chunkSize: { [chainId: number]: number } = Object.fromEntries(
      chainIds.map((_chainId, idx) => {
        const chainId = Number(_chainId);
        return [chainId, 2 + idx * 2];
      })
    );
    const _multiCaller = new DummyMultiCallerClient(spyLogger, chunkSize);

    const testMethod = "test";
    const nFullBundles = 3;
    for (const chainId of chainIds) {
      const multicallTxns: AugmentedTransaction[] = [];
      const _chunkSize = chunkSize[chainId];

      const sampleTxn: AugmentedTransaction = {
        chainId,
        contract: {
          address,
          interface: { encodeFunctionData },
          multicall: 1,
        } as unknown as Contract,
        method: testMethod,
        args: [],
        message: "",
        mrkdwn: "",
      };

      const nTxns = nFullBundles * _chunkSize + 1;
      for (let txn = 0; txn < nTxns; ++txn) {
        expect(sampleTxn.method).to.not.equal("multicall");
        multicallTxns.push(sampleTxn);
      }

      const txnQueue: AugmentedTransaction[] = await _multiCaller.buildMultiCallBundles(multicallTxns, _chunkSize);
      expect(txnQueue.length).to.equal(nFullBundles + 1);

      txnQueue.slice(0, nFullBundles).forEach((txn) => {
        // If chunkSize is 1, no multiCall txns will be bundled.
        expect(txn.method).to.equal(_chunkSize > 1 ? "multicall" : testMethod);
      });
      // txnQueue deliberately has one "spare" txn appended, so it should never be bundled.
      txnQueue.slice(-1).forEach((txn) => expect(txn.method).to.equal(testMethod));
    }
  });

  it("Handles group ID assignment when building multicall bundles", async function () {
    const testMethod = "test";
    const chainId = chainIds[0];
    const groupIds = ["test1", "test2"];
    const multicallTxns: AugmentedTransaction[] = [];
    for (const groupId of groupIds) {
      const sampleTxn: AugmentedTransaction = {
        chainId,
        contract: {
          address,
          interface: { encodeFunctionData },
          multicall: 1,
        } as unknown as Contract,
        method: testMethod,
        args: [],
        message: "",
        mrkdwn: "",
        groupId,
      };
      multicallTxns.push(sampleTxn);
    }

    const txnQueue: AugmentedTransaction[] = await multiCaller.buildMultiCallBundles(multicallTxns);
    expect(txnQueue.length).to.equal(groupIds.length);
  });

  it("Correctly handles 0-length input to multicall bundle generation", async function () {
    const txnQueue: AugmentedTransaction[] = await multiCaller.buildMultiCallBundles([], 10);
    expect(txnQueue.length).to.equal(0);
  });

  it("Correctly handles unpermissioned transactions", async function () {
    const fakeMultisender = await smock.fake(await sdkUtils.getABI("Multicall3"), { address: randomAddress() });
    const multicallerWithMultisend = new DummyMultiCallerClient(spyLogger, {}, fakeMultisender as unknown as Contract);

    // Can't pass any transactions to multisender bundler that are permissioned or different chains:
    void assertPromiseError(
      multicallerWithMultisend.buildMultiSenderBundle([
        {
          chainId: 1,
          unpermissioned: false,
          contract: {
            address,
            interface: { encodeFunctionData },
          } as Contract,
          method: "test",
          args: [],
        },
      ] as AugmentedTransaction[]),
      "Multisender bundle data mismatch"
    );
    void assertPromiseError(
      multicallerWithMultisend.buildMultiSenderBundle([
        {
          chainId: 1,
          unpermissioned: true,
          contract: {
            address,
            interface: { encodeFunctionData },
          } as Contract,
          method: "test",
          args: [],
        },
        {
          chainId: 2,
          unpermissioned: true,
          contract: {
            address,
            interface: { encodeFunctionData },
          } as Contract,
          method: "test",
          args: [],
        },
      ] as AugmentedTransaction[]),
      "Multisender bundle data mismatch"
    );

    // Test returned result of `buildMultiSenderBundle`. Need to check target, expected method, data, etc.
    const unpermissionedTransactions: AugmentedTransaction[] = [
      {
        chainId: 1,
        unpermissioned: true,
        contract: {
          address,
          interface: { encodeFunctionData },
        } as Contract,
        method: "test",
        args: [],
      } as AugmentedTransaction,
    ];
    let multisendTransaction = await multicallerWithMultisend.buildMultiSenderBundle(unpermissionedTransactions);
    expect(multisendTransaction.method).to.equal("aggregate");
    expect(multisendTransaction.contract.address).to.equal(fakeMultisender.address);
    expect(multisendTransaction.args[0].length).to.equal(1);
    expect(multisendTransaction.args[0][0].target).to.equal(address);
    expect(multisendTransaction.args[0][0].callData).to.equal(encodeFunctionData("test()", []));

    const secondAddress = randomAddress();
    unpermissionedTransactions.push({
      chainId: 1,
      unpermissioned: true,
      contract: {
        address: secondAddress,
        interface: { encodeFunctionData },
      } as Contract,
      method: "test2",
      args: [11],
    } as AugmentedTransaction);
    multisendTransaction = await multicallerWithMultisend.buildMultiSenderBundle(unpermissionedTransactions);
    expect(multisendTransaction.method).to.equal("aggregate");
    expect(multisendTransaction.contract.address).to.equal(fakeMultisender.address);
    expect(multisendTransaction.args[0].length).to.equal(2);
    expect(multisendTransaction.args[0][1].target).to.equal(secondAddress);
    expect(multisendTransaction.args[0][1].callData).to.equal(encodeFunctionData("test2(uint256)", [11]));

    // Test that `buildMultiCallBundles` returns correct list (and order) of transactions
    // given a list of transactions that can be bundled together.
    const permissionedTransaction = [
      {
        chainId: 1,
        contract: {
          address: address,
          interface: { encodeFunctionData },
          multicall: 1,
        } as unknown as Contract,
        method: "test",
        args: [],
      },
      {
        chainId: 1,
        contract: {
          address: address,
          interface: { encodeFunctionData },
          multicall: 1,
        } as unknown as Contract,
        method: "test",
        args: [],
      },
    ] as AugmentedTransaction[];
    const bundle = await multicallerWithMultisend.buildMultiCallBundles([
      ...permissionedTransaction,
      ...unpermissionedTransactions,
    ]);
    expect(bundle.length).to.equal(2);

    expect(bundle[0].method).to.equal("multicall");
    expect(bundle[1].method).to.equal("aggregate");
    expect(bundle[1].args[0][0].target).to.equal(address);
    expect(bundle[1].args[0][1].target).to.equal(secondAddress);
    expect(bundle[1].args[0][0].callData).to.equal(encodeFunctionData("test()", []));
    expect(bundle[1].args[0][1].callData).to.equal(encodeFunctionData("test2(uint256)", [11]));
  });
});
