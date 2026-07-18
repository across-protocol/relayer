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
    await apiClient.update(false);

    expect(apiClient.updatedLimits).to.be.true;
    expect(apiClient.getLimit(OPTIMISM, mainnetWeth).eq(limit)).to.be.true;
  });

  it("Retains last known limits when the limits update fails", async function () {
    const limit = toBN(100);
    apiClient.setLiquidReserves([limit]);
    await apiClient.update(false);
    expect(apiClient.getLimit(OPTIMISM, mainnetWeth).eq(limit)).to.be.true;

    // A subsequent failed update falls back to the previously fetched limit.
    apiClient.setLiquidReserves(undefined);
    apiClient.expireUpdate();
    await apiClient.update(false);
    expect(apiClient.updatedLimits).to.be.true;
    expect(apiClient.getLimit(OPTIMISM, mainnetWeth).eq(limit)).to.be.true;

    // A subsequent successful update overwrites the retained limit.
    const newLimit = toBN(50);
    apiClient.setLiquidReserves([newLimit]);
    apiClient.expireUpdate();
    await apiClient.update(false);
    expect(apiClient.getLimit(OPTIMISM, mainnetWeth).eq(newLimit)).to.be.true;
  });

  it("Defaults to a limit of 0 when no update has succeeded", async function () {
    apiClient.setLiquidReserves(undefined);
    await apiClient.update(false);

    expect(apiClient.updatedLimits).to.be.true;
    expect(apiClient.getLimit(OPTIMISM, mainnetWeth).eq(bnZero)).to.be.true;
  });

  it("Applies no limit to hub chain origins", async function () {
    apiClient.setLiquidReserves(undefined);
    await apiClient.update(false);

    expect(apiClient.getLimit(MAINNET, mainnetWeth).eq(bnUint256Max)).to.be.true;
  });
});
