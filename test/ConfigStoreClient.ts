import { ConfigStoreClient, GLOBAL_CONFIG_STORE_KEYS } from "../src/clients/ConfigStoreClient";
import {
  Contract,
  createSpyLogger,
  deployConfigStore,
  ethers,
  expect,
  hubPoolFixture,
  sinon,
  utf8ToHex,
  winston,
} from "./utils";

// Chain onboarded via INJECT_CHAIN_ID_INCLUSION, matching the example in .env.example.
const injectedChainId = 8453;
// A second chain onboarded in the same genuine on-chain transaction as the injected one.
const coOnboardedChainId = 59144;

describe("ConfigStoreClient: injected chain ID inclusion", function () {
  let spy: sinon.SinonSpy;
  let spyLogger: winston.Logger;
  let configStore: Contract;
  // CHAIN_ID_INDICES is append-only against an implicit [hubChainId] baseline, so every update must
  // begin with the local hub chain ID rather than the protocol's mainnet defaults.
  let baseline: number[];

  const overrideLogCount = () =>
    spy.getCalls().filter((call) => JSON.stringify(call.lastArg ?? "").includes("overrides INJECT_CHAIN_ID_INCLUSION"))
      .length;

  const setChainIdIndices = async (chainIds: number[]): Promise<number> => {
    const txn = await configStore.updateGlobalConfig(
      utf8ToHex(GLOBAL_CONFIG_STORE_KEYS.CHAIN_ID_INDICES),
      JSON.stringify(chainIds)
    );
    const { blockNumber } = await txn.wait();
    return blockNumber;
  };

  beforeEach(async function () {
    const [owner] = await ethers.getSigners();
    ({ spy, spyLogger } = createSpyLogger());

    const { dai: l1Token } = await hubPoolFixture();
    ({ configStore } = await deployConfigStore(owner, [l1Token]));

    const { chainId: hubChainId } = await configStore.provider.getNetwork();
    baseline = [hubChainId, 10, 137, 288, 42161];

    // Seed a genuine CHAIN_ID_INDICES update so there is a real "last update" to append to. Inject at
    // a strictly later block: the injection must not predate the last genuine update, and sharing a
    // block with it would leave the synthetic entry shadowed by the real one when sorting.
    await setChainIdIndices(baseline);
    await ethers.provider.send("evm_mine", []);
    process.env.INJECT_CHAIN_ID_INCLUSION = JSON.stringify({
      chainId: injectedChainId,
      blockNumber: await configStore.provider.getBlockNumber(),
    });
  });

  afterEach(function () {
    delete process.env.INJECT_CHAIN_ID_INCLUSION;
  });

  it("injects the configured chain before it is onboarded on-chain", async function () {
    const configStoreClient = new ConfigStoreClient(spyLogger, configStore);
    await configStoreClient.update();

    expect(configStoreClient.getChainIdIndicesForBlock()).to.deep.equal([...baseline, injectedChainId]);
    expect(overrideLogCount()).to.equal(0);
  });

  it("retains a genuine on-chain update that includes the injected chain, across repeated update() calls", async function () {
    const configStoreClient = new ConfigStoreClient(spyLogger, configStore);
    await configStoreClient.update();

    // The chain is genuinely onboarded on-chain, together with a second chain in the same update.
    await setChainIdIndices([...baseline, injectedChainId, coOnboardedChainId]);
    const expected = [...baseline, injectedChainId, coOnboardedChainId];

    // Cycle N: the real update is fetched and the injection is correctly skipped.
    await configStoreClient.update();
    expect(configStoreClient.getChainIdIndicesForBlock()).to.deep.equal(expected);

    // Cycle N+1 is the regression: the pre-filter used to delete the real update by chain-ID
    // membership, and super.update() could not re-fetch it because the search window had advanced.
    // That dropped coOnboardedChainId entirely and back-dated injectedChainId to the injected block.
    await configStoreClient.update();
    expect(configStoreClient.getChainIdIndicesForBlock()).to.deep.equal(expected);

    // Further cycles must remain stable.
    await configStoreClient.update();
    expect(configStoreClient.getChainIdIndicesForBlock()).to.deep.equal(expected);
  });

  it("logs the on-chain override loudly, but only once per process", async function () {
    const configStoreClient = new ConfigStoreClient(spyLogger, configStore);
    await configStoreClient.update();
    expect(overrideLogCount()).to.equal(0);

    await setChainIdIndices([...baseline, injectedChainId]);

    await configStoreClient.update();
    expect(overrideLogCount()).to.equal(1);

    // The guard is re-evaluated every cycle; the warning must not be repeated on each one.
    await configStoreClient.update();
    await configStoreClient.update();
    expect(overrideLogCount()).to.equal(1);
  });
});
