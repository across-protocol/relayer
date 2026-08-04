import { AcrossApiClient, ConfigStoreClient } from "../src/clients";
import { bnUint256Max, bnZero, CHAIN_IDs, EvmAddress, TOKEN_SYMBOLS_MAP } from "../src/utils";
import { MockHubPoolClient } from "./mocks";
import { BigNumber, createSpyLogger, deployConfigStore, ethers, expect, hubPoolFixture, toBN, winston } from "./utils";

class MockAcrossApiClient extends AcrossApiClient {
  private liquidReserves: BigNumber[] | undefined = undefined;

  setLiquidReserves(liquidReserves: BigNumber[] | undefined): void {
    this.liquidReserves = liquidReserves;
  }

  // Reset the update retention window so that the next update() queries limits again.
  expireUpdate(): void {
    this.updatedAt = 0;
  }

  protected callLimits(): Promise<BigNumber[] | undefined> {
    return Promise.resolve(this.liquidReserves);
  }
}

describe("AcrossApiClient", function () {
  const { MAINNET, OPTIMISM } = CHAIN_IDs;
  const mainnetWeth = EvmAddress.from(TOKEN_SYMBOLS_MAP.WETH.addresses[MAINNET]);

  let spyLogger: winston.Logger;
  let hubPoolClient: MockHubPoolClient;
  let apiClient: MockAcrossApiClient;

  beforeEach(async function () {
    const [owner] = await ethers.getSigners();
    ({ spyLogger } = createSpyLogger());

    const { hubPool, dai: l1Token } = await hubPoolFixture();
    const { configStore } = await deployConfigStore(owner, [l1Token]);
    const configStoreClient = new ConfigStoreClient(spyLogger, configStore);
    await configStoreClient.update();

    hubPoolClient = new MockHubPoolClient(spyLogger, hubPool, configStoreClient);
    await hubPoolClient.update();
    hubPoolClient.addL1Token({ address: mainnetWeth, decimals: 18, symbol: "WETH" });

    apiClient = new MockAcrossApiClient(spyLogger, hubPoolClient, [MAINNET, OPTIMISM], [mainnetWeth]);
  });

  it("Stores limits on successful update", async function () {
    const limit = toBN(100);
    apiClient.setLiquidReserves([limit]);
    expect(await apiClient.update(false)).to.be.true;

    expect(apiClient.updatedLimits).to.be.true;
    expect(apiClient.getLimit(OPTIMISM, mainnetWeth).eq(limit)).to.be.true;
  });

  it("Retains last known limits when the limits update fails", async function () {
    const limit = toBN(100);
    apiClient.setLiquidReserves([limit]);
    await apiClient.update(false);
    expect(apiClient.getLimit(OPTIMISM, mainnetWeth).eq(limit)).to.be.true;

    // A subsequent failed update reports failure but falls back to the previously fetched limit.
    apiClient.setLiquidReserves(undefined);
    apiClient.expireUpdate();
    expect(await apiClient.update(false)).to.be.false;
    expect(apiClient.updatedLimits).to.be.true;
    expect(apiClient.getLimit(OPTIMISM, mainnetWeth).eq(limit)).to.be.true;

    // A subsequent successful update overwrites the retained limit.
    const newLimit = toBN(50);
    apiClient.setLiquidReserves([newLimit]);
    apiClient.expireUpdate();
    expect(await apiClient.update(false)).to.be.true;
    expect(apiClient.getLimit(OPTIMISM, mainnetWeth).eq(newLimit)).to.be.true;
  });

  it("Reports failure without throwing when no update has succeeded", async function () {
    apiClient.setLiquidReserves(undefined);
    expect(await apiClient.update(false)).to.be.false;

    // Limits are not enforced until an update succeeds, so the caller must retry rather than fill.
    expect(apiClient.updatedLimits).to.be.false;
    expect(apiClient.getLimit(OPTIMISM, mainnetWeth).eq(bnZero)).to.be.true;

    // updatedAt is left unset on failure, so a retry queries again instead of skipping on the retention window.
    const limit = toBN(100);
    apiClient.setLiquidReserves([limit]);
    expect(await apiClient.update(false)).to.be.true;
    expect(apiClient.updatedLimits).to.be.true;
    expect(apiClient.getLimit(OPTIMISM, mainnetWeth).eq(limit)).to.be.true;
  });

  it("Skips the update when limits are ignored", async function () {
    apiClient.setLiquidReserves(undefined);
    expect(await apiClient.update(true)).to.be.true;
    expect(apiClient.updatedLimits).to.be.false;
  });

  it("Applies no limit to hub chain origins", async function () {
    apiClient.setLiquidReserves([toBN(100)]);
    await apiClient.update(false);

    expect(apiClient.getLimit(MAINNET, mainnetWeth).eq(bnUint256Max)).to.be.true;
  });
});
