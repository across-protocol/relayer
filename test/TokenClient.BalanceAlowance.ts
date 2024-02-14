import { HubPoolClient, SpokePoolClient, TokenClient } from "../src/clients"; // Tested
import { originChainId, destinationChainId, ZERO_ADDRESS } from "./constants";
import {
  Contract,
  SignerWithAddress,
  createSpyLogger,
  deployAndConfigureHubPool,
  deploySpokePoolWithToken,
  ethers,
  expect,
  toBNWei,
  winston,
} from "./utils";

let spokePool_1: Contract, spokePool_2: Contract;
let erc20_1: Contract, weth_1: Contract, erc20_2: Contract, weth_2: Contract;
let spokePoolClient_1: SpokePoolClient, spokePoolClient_2: SpokePoolClient;
let owner: SignerWithAddress, spyLogger: winston.Logger;
let tokenClient: TokenClient; // tested
let spokePool1DeploymentBlock: number, spokePool2DeploymentBlock: number;

describe("TokenClient: Balance and Allowance", async function () {
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
    const { hubPool } = await deployAndConfigureHubPool(owner, [], ZERO_ADDRESS, ZERO_ADDRESS);

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

    const spokePoolClients = { [destinationChainId]: spokePoolClient_1, [originChainId]: spokePoolClient_2 };
    const hubPoolClient = new HubPoolClient(createSpyLogger().spyLogger, hubPool, null);

    tokenClient = new TokenClient(spyLogger, owner.address, spokePoolClients, hubPoolClient);
  });

  it("Fetches all associated balances", async function () {
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
    expect(tokenData).to.deep.equal(expectedData);

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
    expect(tokenData1).to.deep.equal(expectedData1);

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

async function updateAllClients() {
  await spokePoolClient_1.update();
  await spokePoolClient_2.update();
  await tokenClient.update();
}
