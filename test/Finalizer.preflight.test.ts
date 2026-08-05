import { preflightFinalizations } from "../src/finalizer";
import { CrossChainMessage } from "../src/finalizer/types";
import { getMultisender, Multicall2Call } from "../src/utils";
import {
  Contract,
  SignerWithAddress,
  assertPromiseError,
  createSpyLogger,
  deployMulticall3,
  ethers,
  expect,
} from "./utils";
import { originChainId, repaymentChainId } from "./constants";

describe("Finalizer: finalization pre-flight", function () {
  let owner: SignerWithAddress;
  let target: Contract, multisender: Contract;
  let chainId: number;

  const call = (method: string): Multicall2Call => ({
    target: target.address,
    callData: target.interface.encodeFunctionData(method, []),
  });

  const finalization = (method: string, originationChainId = originChainId) => ({
    txn: call(method),
    crossChainMessage: {
      originationChainId,
      destinationChainId: chainId,
      l1TokenSymbol: "TEST",
      amount: "1",
      type: "withdrawal",
    } as CrossChainMessage,
  });

  const preflight = async (finalizations: ReturnType<typeof finalization>[]) => {
    const { spy, spyLogger } = createSpyLogger();
    const result = await preflightFinalizations(spyLogger, chainId, multisender, owner.address, finalizations);
    const log = (substring: string) =>
      spy
        .getCalls()
        .map(({ lastArg }) => lastArg)
        .find(({ message }) => (message as string)?.includes(substring));
    return { ...result, log };
  };

  beforeEach(async function () {
    [owner] = await ethers.getSigners();
    await deployMulticall3(owner);

    ({ chainId } = await owner.provider.getNetwork());
    multisender = getMultisender(chainId, owner) as Contract;
    expect(multisender).to.not.be.undefined;

    target = await (await ethers.getContractFactory("MockFinalizationTarget", owner)).deploy(multisender.address);
  });

  it("Simulates each call as Multicall3 rather than as the EOA", async function () {
    const healthy = finalization("finalizeWithdrawal");

    // This call really is msg.sender-dependent: simulated from the EOA, as the pre-flight this replaced
    // did, it reverts -- and a finalization that would have succeeded gets thrown out.
    await assertPromiseError(
      ethers.provider.send("eth_call", [
        { from: owner.address, to: healthy.txn.target, data: healthy.txn.callData },
        "latest",
      ])
    );

    const { callsToSubmit, excluded } = await preflight([healthy]);
    expect(excluded.length).to.equal(0);
    expect(callsToSubmit).to.deep.equal([healthy.txn]);
  });

  it("Excludes a reverting call and names it, keeping the rest of the batch", async function () {
    const healthy = finalization("finalizeWithdrawal");
    const bad = finalization("notProven", repaymentChainId);

    const { callsToSubmit, excluded, log } = await preflight([healthy, bad, healthy]);
    expect(callsToSubmit).to.deep.equal([healthy.txn, healthy.txn]);
    expect(excluded.length).to.equal(1);
    expect(excluded[0].crossChainMessage).to.equal(bad.crossChainMessage);
    expect(excluded[0].benign).to.be.false;

    // The culprit is named at error level, with the inner revert reason decoded out of the payload that
    // aggregate() would have discarded.
    const errorLog = log("Excluded 1 reverting finalization");
    expect(errorLog?.level).to.equal("error");
    expect(errorLog?.notificationPath).to.equal("across-error");
    expect(errorLog?.reverted[0].reason).to.equal("withdrawal not proven");
  });

  it("Keeps a race with another finalizer quiet", async function () {
    // ClaimedMerkleLeaf() is a known benign reason, reported as a custom error rather than a string.
    const { callsToSubmit, excluded, log } = await preflight([finalization("alreadyClaimed")]);
    expect(callsToSubmit.length).to.equal(0);
    expect(excluded.length).to.equal(1);
    expect(excluded[0].benign).to.be.true;

    expect(log("Excluded 1 reverting finalization")).to.be.undefined;
    const debugLog = log("Excluded 1 already-finalized message");
    expect(debugLog?.level).to.equal("debug");
    expect(debugLog?.races[0].reason).to.equal("ClaimedMerkleLeaf");
  });
});
