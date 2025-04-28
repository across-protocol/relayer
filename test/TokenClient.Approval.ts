import { ConfigStoreClient, SpokePoolClient } from "../src/clients";
import { originChainId, destinationChainId, ZERO_ADDRESS } from "./constants";
import {
  Contract,
  MAX_UINT_VAL,
  SignerWithAddress,
  createSpyLogger,
  deployConfigStore,
  deployAndConfigureHubPool,
  deploySpokePoolWithToken,
  ethers,
  expect,
  getContractFactory,
  lastSpyLogIncludes,
  sinon,
  toBNWei,
  utf8ToHex,
  winston,
  deployMulticall3,
} from "./utils";
import { MockHubPoolClient, SimpleMockTokenClient } from "./mocks";

describe("TokenClient: Origin token approval", async function () {
  let spokePool_1: Contract, spokePool_2: Contract, hubPool: Contract;
  let erc20_1: Contract,
    weth_1: Contract,
    erc20_2: Contract,
    weth_2: Contract,
    l1Token_1: Contract,
    l1Token_2: Contract;
  let hubPoolClient: MockHubPoolClient, spokePoolClient_1: SpokePoolClient, spokePoolClient_2: SpokePoolClient;
  let owner: SignerWithAddress, spy: sinon.SinonSpy, spyLogger: winston.Logger;
  let tokenClient: SimpleMockTokenClient; // tested
  let spokePool1DeploymentBlock: number, spokePool2DeploymentBlock: number;

  const updateAllClients = async () => {
    await hubPoolClient.update();
    await spokePoolClient_1.update();
    await spokePoolClient_2.update();
    await tokenClient.update();
  };

  beforeEach(async function () {
    [owner] = await ethers.getSigners();
    ({ spy, spyLogger } = createSpyLogger());
    // Using deploySpokePoolWithToken will create two tokens and enable both of them as routes.
    ({
      spokePool: spokePool_1,
      erc20: erc20_1,
      weth: weth_1,
      deploymentBlock: spokePool1DeploymentBlock,
    } = await deploySpokePoolWithToken(originChainId, destinationChainId));
    ({
      spokePool: spokePool_2,
      erc20: erc20_2,
      weth: weth_2,
      deploymentBlock: spokePool2DeploymentBlock,
    } = await deploySpokePoolWithToken(destinationChainId, originChainId));
    const finder = await (await getContractFactory("Finder", owner)).deploy();
    const collateralWhitelist = await (await getContractFactory("AddressWhitelist", owner)).deploy();
    const store = await (
      await getContractFactory("Store", owner)
    ).deploy({ rawValue: "0" }, { rawValue: "0" }, ZERO_ADDRESS);
    await finder.changeImplementationAddress(utf8ToHex("CollateralWhitelist"), collateralWhitelist.address);
    await finder.changeImplementationAddress(utf8ToHex("Store"), store.address);
    ({ hubPool, l1Token_1, l1Token_2 } = await deployAndConfigureHubPool(owner, [], finder.address, ZERO_ADDRESS));
    await collateralWhitelist.addToWhitelist(l1Token_1.address);
    await hubPool.setBond(l1Token_1.address, toBNWei("5"));
    spokePoolClient_1 = new SpokePoolClient(
      createSpyLogger().spyLogger,
      spokePool_1,
      null,
      originChainId,
      spokePool1DeploymentBlock
    );
    spokePoolClient_2 = new SpokePoolClient(
      createSpyLogger().spyLogger,
      spokePool_2,
      null,
      destinationChainId,
      spokePool2DeploymentBlock
    );

    const spokePoolClients = { [originChainId]: spokePoolClient_1, [destinationChainId]: spokePoolClient_2 };

    const { configStore } = await deployConfigStore(owner, [l1Token_1, l1Token_2]);
    const configStoreClient = new ConfigStoreClient(spyLogger, configStore, { fromBlock: 0 }, 0);
    await configStoreClient.update();
    hubPoolClient = new MockHubPoolClient(createSpyLogger().spyLogger, hubPool, configStoreClient);

    for (const token of [l1Token_1, l1Token_2]) {
      hubPoolClient.addL1Token({
        address: token.address,
        symbol: await token.symbol(),
        decimals: await token.decimals(),
      });
    }
    hubPoolClient.setTokenMapping(l1Token_1.address, originChainId, erc20_1.address);
    hubPoolClient.setTokenMapping(l1Token_1.address, destinationChainId, erc20_2.address);
    hubPoolClient.setTokenMapping(l1Token_2.address, originChainId, weth_1.address);
    hubPoolClient.setTokenMapping(l1Token_2.address, destinationChainId, weth_2.address);

    // Deploy Multicall3 to the hardhat test networks.
    await deployMulticall3(owner);

    tokenClient = new SimpleMockTokenClient(spyLogger, owner.address, spokePoolClients, hubPoolClient);
    tokenClient.setRemoteTokens([l1Token_1, l1Token_2, erc20_1, erc20_2, weth_1, weth_2]);
  });

  it("Executes expected L2 token approvals and produces logs", async function () {
    await updateAllClients();

    // Token client will not set allowances for tokens with zero balance.
    await tokenClient.setOriginTokenApprovals();
    expect(lastSpyLogIncludes(spy, "All token approvals set for non-zero balances")).to.be.true;

    // Mint token client account some tokens and check that approvals are sent
    await erc20_1.connect(owner).mint(owner.address, "1");
    await erc20_2.connect(owner).mint(owner.address, "1");
    await weth_1.connect(owner).deposit({ value: "1" });
    await weth_2.connect(owner).deposit({ value: "1" });
    await updateAllClients();
    await tokenClient.setOriginTokenApprovals();

    // logs should contain expected text and the addresses of all 4 tokens approved.
    expect(lastSpyLogIncludes(spy, "Approval transactions")).to.be.true;
    expect(lastSpyLogIncludes(spy, erc20_1.address)).to.be.true;
    expect(lastSpyLogIncludes(spy, erc20_2.address)).to.be.true;
    expect(lastSpyLogIncludes(spy, weth_1.address)).to.be.true;
    expect(lastSpyLogIncludes(spy, weth_2.address)).to.be.true;

    // Approvals should be set correctly. Note that erc20_1 is checked to be approved on spokePool_2 and erc20_2 is
    // checked on spokePool_1 as this is the associated token route.
    expect(await erc20_1.allowance(owner.address, spokePool_1.address)).to.equal(MAX_UINT_VAL);
    expect(await erc20_2.allowance(owner.address, spokePool_2.address)).to.equal(MAX_UINT_VAL);
    expect(await weth_1.allowance(owner.address, spokePool_1.address)).to.equal(MAX_UINT_VAL);
    expect(await weth_2.allowance(owner.address, spokePool_2.address)).to.equal(MAX_UINT_VAL);

    // Does not send allowances again.
    await updateAllClients();
    await tokenClient.setOriginTokenApprovals();
    expect(lastSpyLogIncludes(spy, "All token approvals set for non-zero balances")).to.be.true;
  });
  it("Executes expected L1 token approvals", async function () {
    await updateAllClients();

    await tokenClient.setBondTokenAllowance();
    expect(await l1Token_1.allowance(owner.address, hubPool.address)).to.equal(MAX_UINT_VAL);
  });
});
