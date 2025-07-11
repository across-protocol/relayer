import { MultiCallerClient, SpokePoolClient } from "../src/clients";
import { MAX_UINT_VAL } from "../src/utils";
import { CHAIN_ID_TEST_LIST } from "./constants";
import { setupFastDataworker } from "./fixtures/Dataworker.Fixture";
import {
  Contract,
  ethers,
  expect,
  lastSpyLogIncludes,
  lastSpyLogLevel,
  sinon,
  spyLogIncludes,
  spyLogLevel,
  utf8ToHex,
} from "./utils";

// Tested
import { Dataworker } from "../src/dataworker/Dataworker";

let spy: sinon.SinonSpy;
let l1Token_1: Contract, hubPool: Contract;

let dataworkerInstance: Dataworker, multiCallerClient: MultiCallerClient;
let spokePoolClients: { [chainId: number]: SpokePoolClient };

let updateAllClients: () => Promise<void>;

describe("Dataworker: Using SpokePool clients with short lookback windows", async function () {
  beforeEach(async function () {
    ({ hubPool, l1Token_1, dataworkerInstance, spokePoolClients, multiCallerClient, updateAllClients, spy } =
      await setupFastDataworker(
        ethers,
        1 // Use very short lookback
      ));
  });

  it("Cannot propose", async function () {
    await updateAllClients();

    // Attempting to propose a root fails because bundle block range has a start blocks < spoke clients fromBlock's
    // (because lookback is set to low)
    await dataworkerInstance.proposeRootBundle(
      spokePoolClients,
      undefined,
      true,
      Object.fromEntries(Object.keys(spokePoolClients).map((chainId) => [chainId, Number.MAX_SAFE_INTEGER]))
    );
    expect(lastSpyLogIncludes(spy, "Cannot propose bundle with insufficient event data")).to.be.true;
    expect(lastSpyLogLevel(spy)).to.equal("warn");
    expect(multiCallerClient.transactionCount()).to.equal(0);
  });
  it("Cannot validate", async function () {
    await updateAllClients();

    // propose arbitrary bundle
    await l1Token_1.approve(hubPool.address, MAX_UINT_VAL);
    await hubPool.proposeRootBundle(
      Array(CHAIN_ID_TEST_LIST.length).fill(await hubPool.provider.getBlockNumber()),
      1,
      utf8ToHex("BogusRoot"),
      utf8ToHex("BogusRoot"),
      utf8ToHex("BogusRoot")
    );
    await updateAllClients();
    await dataworkerInstance.validatePendingRootBundle(
      spokePoolClients,
      true,
      Object.fromEntries(Object.keys(spokePoolClients).map((chainId) => [chainId, Number.MAX_SAFE_INTEGER]))
    );
    expect(lastSpyLogIncludes(spy, "Skipping dispute")).to.be.true;
    expect(spyLogLevel(spy, -1)).to.equal("error");
    expect(spyLogIncludes(spy, -2, "Cannot validate bundle with insufficient event data")).to.be.true;
    expect(spyLogLevel(spy, -2)).to.equal("warn");
    expect(multiCallerClient.transactionCount()).to.equal(0);
  });
});
