import { utils as sdkUtils } from "@across-protocol/sdk";
import { AugmentedTransaction, TryMulticallClient } from "../src/clients";
import { BigNumber, TransactionSimulationResult } from "../src/utils";
import { MockedTransactionClient, txnClientPassResult } from "./mocks/MockTransactionClient";
import { CHAIN_ID_TEST_LIST as chainIds } from "./constants";
import {
  createSpyLogger,
  Contract,
  expect,
  randomAddress,
  winston,
  toBN,
  smock,
  assertPromiseError,
  getContractFactory,
} from "./utils";

class DummyTryMulticallClient extends TryMulticallClient {
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

  // By default return undefined multisender so dataworker can just fallback to calling Multicaller instead
  // of having to deploy a Multisend2 on this network.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async _getMultisender(_: number): Promise<Contract | undefined> {
    return this.multisend;
  }
}

// encodeFunctionData is called from within MultiCallerClient.buildMultiCallBundle.
function encodeFunctionData(_method: string, args: ReadonlyArray<unknown> = []): string {
  return args;
}

describe("TryMulticallClient", async function () {
  describe("MockTransactionClient Tests", async function () {
    const { spyLogger }: { spyLogger: winston.Logger } = createSpyLogger();
    const address = randomAddress(); // Test contract address
    let multiCaller: DummyTryMulticallClient;

    beforeEach(async function () {
      multiCaller = new DummyTryMulticallClient(spyLogger);
      expect(multiCaller.transactionCount()).to.equal(0);
      expect(multiCaller.simulationFailureCount()).to.equal(0);
    });

    it("Propagates input transaction gasLimits: internal multicall", async function () {
      const fakeMultisender = await smock.fake(await sdkUtils.getABI("Multicall3"), { address: randomAddress() });
      multiCaller = new DummyTryMulticallClient(spyLogger, {}, fakeMultisender as unknown as Contract);

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
      multiCaller = new DummyTryMulticallClient(spyLogger, {}, fakeMultisender as unknown as Contract);

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

    it("Correctly handles unpermissioned transactions", async function () {
      const fakeMultisender = await smock.fake(await sdkUtils.getABI("Multicall3"), { address: randomAddress() });
      const multicallerWithMultisend = new DummyTryMulticallClient(
        spyLogger,
        {},
        fakeMultisender as unknown as Contract
      );

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

      expect(bundle[0].method).to.equal("tryMulticall");
      expect(bundle[1].method).to.equal("aggregate");
      expect(bundle[1].args[0][0].target).to.equal(address);
      expect(bundle[1].args[0][1].target).to.equal(secondAddress);
    });
  });
  describe("MockSpokePool Tests", async function () {
    const { spyLogger }: { spyLogger: winston.Logger } = createSpyLogger();
    let multiCaller: TryMulticallClient;
    let multicallReceiver: Contract;

    beforeEach(async function () {
      const [deployer] = await ethers.getSigners();

      multiCaller = new TryMulticallClient(spyLogger);
      expect(multiCaller.transactionCount()).to.equal(0);
      multicallReceiver = await (await getContractFactory("MockMulticallReceiver", deployer)).deploy();
    });

    it("Correctly rebuilds a tryMulticall from successful transaction data", async function () {
      // We replace chainId 1 in chainIds since we are using the prod transaction client. Upon "submission" to the hardhat network
      // in this test, since it thinks it is on chain id 1, it will attempt to create a block explorer link and subsequently error out.
      chainIds = chainIds.filter((chainId) => chainId !== 1);
      for (const chainId of chainIds) {
        let nSucceed = 0;
        const nTxns = 5;
        for (let j = 0; j < nTxns; ++j) {
          const succeed = Math.floor(Math.random() * 2); // 0 is fail, 1 is pass.
          nSucceed += succeed;
          const txn = {
            chainId,
            contract: {
              ...multicallReceiver,
              interface: { encodeFunctionData },
            } as Contract,
            args: [succeed],
            message: `Test transaction on chain ${chainId}`,
            mrkdwn: `This transaction is expected to ${succeed === 0 ? "fail" : "pass"} simulation.`,
          } as AugmentedTransaction;
          multiCaller.enqueueTransaction(txn);
        }
        const nBundles = nSucceed === 0 ? 0 : 1;
        expect(multiCaller.transactionCount()).to.equal(nTxns);
        const results = await multiCaller.executeTxnQueue(chainId, false);
        expect(results.length).to.equal(nBundles);
        if (nBundles !== 0) {
          const returnData = results[0];
          expect(returnData.length).to.equal(nSucceed);
        }
      }
    });
    it("Does not combine separate multicall bundles together", async function () {
      // We replace chainId 1 in chainIds since we are using the prod transaction client. Upon "submission" to the hardhat network
      // in this test, since it thinks it is on chain id 1, it will attempt to create a block explorer link and subsequently error out.
      chainIds = chainIds.filter((chainId) => chainId !== 1);
      const chunkSize = 5; // Should divide nTxns evenly.
      for (const chainId of chainIds) {
        // Overwrite the chunk size to be 5.
        multiCaller.chunkSize[chainId] = chunkSize;
        let nSucceed = 0;
        const nTxns = 20;
        const queueCopy = [];
        for (let j = 0; j < nTxns; ++j) {
          const succeed = Math.floor(Math.random() * 2); // 0 is fail, 1 is pass.
          nSucceed += succeed;
          const txn = {
            chainId,
            contract: {
              ...multicallReceiver,
              interface: { encodeFunctionData },
            } as Contract,
            args: [succeed],
            message: `Test transaction on chain ${chainId}`,
            mrkdwn: `This transaction is expected to ${succeed === 0 ? "fail" : "pass"} simulation.`,
          } as AugmentedTransaction;
          multiCaller.enqueueTransaction(txn);
          queueCopy.push(succeed);
        }
        // Determine if all 5 transactions in a bundle failed. This assumes chunkSize | nTxns.
        let emptyBundles = 0;
        const nBundles = nTxns / chunkSize;
        for (let i = 0; i < nBundles; i++) {
          const wdow = i * chunkSize;
          const sum = queueCopy.slice(wdow, wdow + chunkSize).reduce((sum, current) => sum + current, 0);
          if (sum === 0) {
            emptyBundles++;
          }
        }
        expect(multiCaller.transactionCount()).to.equal(nTxns);
        const results = await multiCaller.executeTxnQueue(chainId, false);
        expect(results.length).to.equal(nBundles - emptyBundles); // With a chunk size of 5 and 20 transactions, 4 bundles should have been built.
        expect(results.reduce((sum, result) => sum + result.length, 0)).to.equal(nSucceed);
      }
    });
  });
});
