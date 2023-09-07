import {
  deployConfigStore,
  getContractFactory,
  expect,
  ethers,
  Contract,
  SignerWithAddress,
  zeroAddress,
  createSpyLogger,
} from "./utils";
import { ConfigStoreClient, HubPoolClient } from "../src/clients";
import { CONFIG_STORE_VERSION } from "./constants";

let hubPool: Contract, lpTokenFactory: Contract;
let owner: SignerWithAddress;
let hubPoolClient: HubPoolClient;

describe("HubPoolClient: L1Tokens", function () {
  beforeEach(async function () {
    [owner] = await ethers.getSigners();

    lpTokenFactory = await (await getContractFactory("LpTokenFactory", owner)).deploy();

    hubPool = await (
      await getContractFactory("HubPool", owner)
    ).deploy(lpTokenFactory.address, zeroAddress, zeroAddress, zeroAddress);

    const logger = createSpyLogger().spyLogger;
    const { configStore } = await deployConfigStore(owner, []);

    const configStoreClient = new ConfigStoreClient(logger, configStore, { fromBlock: 0 }, CONFIG_STORE_VERSION);
    await configStoreClient.update();

    hubPoolClient = new HubPoolClient(logger, hubPool, configStoreClient);

    await configStoreClient.update();
    await hubPoolClient.update();
  });

  it("Fetches all L1Tokens Addresses", async function () {
    expect(hubPoolClient.getL1Tokens()).to.deep.equal([]);

    const l1Token1 = await (await getContractFactory("ExpandedERC20", owner)).deploy("Yeet Coin1", "Coin1", 18);
    const l1Token2 = await (await getContractFactory("ExpandedERC20", owner)).deploy("Yeet Coin2", "Coin2", 17);
    const l1Token3 = await (await getContractFactory("ExpandedERC20", owner)).deploy("Yeet Coin3", "Coin3", 16);
    await hubPool.connect(owner).enableL1TokenForLiquidityProvision(l1Token1.address);
    await hubPool.connect(owner).enableL1TokenForLiquidityProvision(l1Token2.address);
    await hubPool.connect(owner).enableL1TokenForLiquidityProvision(l1Token3.address);

    await hubPoolClient.update();
    expect(hubPoolClient.getL1Tokens()).to.deep.equal([
      { address: l1Token1.address, symbol: "Coin1", decimals: 18 },
      { address: l1Token2.address, symbol: "Coin2", decimals: 17 },
      { address: l1Token3.address, symbol: "Coin3", decimals: 16 },
    ]);
  });
});
