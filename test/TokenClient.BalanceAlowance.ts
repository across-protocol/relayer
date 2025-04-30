import { ConfigStoreClient, SpokePoolClient, TokenDataType } from "../src/clients"; // Tested
import { originChainId, destinationChainId, ZERO_ADDRESS } from "./constants";
import { MockHubPoolClient, SimpleMockTokenClient } from "./mocks";
import {
  Contract,
  SignerWithAddress,
  createSpyLogger,
  deployAndConfigureHubPool,
  deployConfigStore,
  deploySpokePoolWithToken,
  ethers,
  expect,
  toBN,
  toBNWei,
  winston,
  deployMulticall3,
} from "./utils";

describe("TokenClient: Balance and Allowance", async function () {
  let spokePool_1: Contract, spokePool_2: Contract;
  let erc20_1: Contract, weth_1: Contract, erc20_2: Contract, weth_2: Contract;
  let hubPoolClient: MockHubPoolClient, spokePoolClient_1: SpokePoolClient, spokePoolClient_2: SpokePoolClient;
  let owner: SignerWithAddress, spyLogger: winston.Logger;
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
    ({ spyLogger } = createSpyLogger());
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

    const {
      hubPool,
      l1Token_1: hubERC20,
      l1Token_2: hubWeth,
    } = await deployAndConfigureHubPool(
      owner,
      [
        { l2ChainId: originChainId, spokePool: spokePool_1 },
        { l2ChainId: destinationChainId, spokePool: spokePool_2 },
      ],
      ZERO_ADDRESS,
      ZERO_ADDRESS
    );
    const { configStore } = await deployConfigStore(owner, [hubERC20, hubWeth]);
    const configStoreClient = new ConfigStoreClient(spyLogger, configStore, { fromBlock: 0 }, 0);
    await configStoreClient.update();

    hubPoolClient = new MockHubPoolClient(spyLogger, hubPool, configStoreClient);
    await hubPoolClient.update();

    for (const token of [hubERC20, hubWeth]) {
      hubPoolClient.addL1Token({
        address: token.address,
        symbol: await token.symbol(),
        decimals: await token.decimals(),
      });
    }

    hubPoolClient.setTokenMapping(hubERC20.address, originChainId, erc20_1.address);
    hubPoolClient.setTokenMapping(hubERC20.address, destinationChainId, erc20_2.address);
    hubPoolClient.setTokenMapping(hubWeth.address, originChainId, weth_1.address);
    hubPoolClient.setTokenMapping(hubWeth.address, destinationChainId, weth_2.address);

    const l1Tokens = hubPoolClient.getL1Tokens();
    expect(l1Tokens.length).to.equal(2);

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

    // Deploy Multicall3 to the hardhat test networks.
    await deployMulticall3(owner);

    tokenClient = new SimpleMockTokenClient(spyLogger, owner.address, spokePoolClients, hubPoolClient);
    tokenClient.setRemoteTokens([], {
      [originChainId]: [erc20_1, weth_1],
      [destinationChainId]: [erc20_2, weth_2],
    });
  });

  it("Fetches all associated balances", async function () {
    const alignTokenData = (data: TokenDataType): TokenDataType =>
      Object.entries(data).reduce((acc, [chainId, tokenData]) => {
        acc[chainId] = Object.entries(tokenData).reduce((acc, [token, { balance, allowance }]) => {
          acc[token] = { balance: toBN(balance), allowance: toBN(allowance) };
          return acc;
        }, {});
        return acc;
      }, {});

    await updateAllClients();
    const expectedData = {
      [originChainId]: {
        [erc20_1.address]: { balance: toBNWei(0), allowance: toBNWei(0) },
        [weth_1.address]: { balance: toBNWei(0), allowance: toBNWei(0) },
      },
      [destinationChainId]: {
        [erc20_2.address]: { balance: toBNWei(0), allowance: toBNWei(0) },
        [weth_2.address]: { balance: toBNWei(0), allowance: toBNWei(0) },
      },
    };
    const tokenData = tokenClient.getAllTokenData();
    expect(alignTokenData(tokenData)).to.deep.equal(expectedData);

    // Check some balance/allowances directly.
    expect(tokenClient.getBalance(originChainId, erc20_1.address)).to.equal(toBNWei(0));
    expect(tokenClient.getBalance(destinationChainId, weth_2.address)).to.equal(toBNWei(0));

    // Mint tokens to the owner. Mint ERC20 on one chain and WETH on the other. See that the client updates accordingly.
    await erc20_1.mint(owner.address, toBNWei(42069));
    await weth_1.approve(spokePool_1.address, toBNWei(420420));
    await erc20_2.approve(spokePool_2.address, toBNWei(6969));
    await weth_2.deposit({ value: toBNWei(1337) });
    await updateAllClients();

    const expectedData1 = {
      [originChainId]: {
        [erc20_1.address]: { balance: toBNWei(42069), allowance: toBNWei(0) },
        [weth_1.address]: { balance: toBNWei(0), allowance: toBNWei(420420) },
      },
      [destinationChainId]: {
        [erc20_2.address]: { balance: toBNWei(0), allowance: toBNWei(6969) },
        [weth_2.address]: { balance: toBNWei(1337), allowance: toBNWei(0) },
      },
    };
    const tokenData1 = tokenClient.getAllTokenData();
    expect(alignTokenData(tokenData1)).to.deep.equal(expectedData1);

    expect(tokenClient.getBalance(originChainId, erc20_1.address)).to.equal(toBNWei(42069));
    expect(tokenClient.getBalance(destinationChainId, weth_2.address)).to.equal(toBNWei(1337));

    // granting an allowance to a different target should not impact the client as the client only monitors allowance
    // of the owner to the spoke pool.
    await erc20_1.approve(spokePool_2.address, toBNWei(11111)); // erc20_1 should not care about approval on spokePool_2.
    await updateAllClients();
    expect(tokenClient.getBalance(originChainId, erc20_1.address)).to.equal(toBNWei(42069)); // same as before.
  });
  it("Can modify stored balances synchronously", async function () {
    // During the normal operation of the relayer we should be able to synchronously subtract balance from a given token
    // to track how much is remaining within a given run.
    await updateAllClients();
    expect(tokenClient.getBalance(originChainId, erc20_1.address)).to.equal(toBNWei(0));
    await erc20_1.mint(owner.address, toBNWei(42069));
    await updateAllClients();
    expect(tokenClient.getBalance(originChainId, erc20_1.address)).to.equal(toBNWei(42069));
    tokenClient.decrementLocalBalance(originChainId, erc20_1.address, toBNWei(69));
    expect(tokenClient.getBalance(originChainId, erc20_1.address)).to.equal(toBNWei(42000));

    // Send tokens away to ensure that the balance update is reflected during the update.
    await erc20_1.transfer(spokePool_1.address, toBNWei(69)); // send to some random address.
    await updateAllClients();
    expect(tokenClient.getBalance(originChainId, erc20_1.address)).to.equal(toBNWei(42000));
  });
});
