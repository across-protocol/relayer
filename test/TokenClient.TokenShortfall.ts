import { HubPoolClient, SpokePoolClient, TokenClient } from "../src/clients";
import { MockConfigStoreClient } from "./mocks";
import {
  Contract,
  SignerWithAddress,
  createSpyLogger,
  deployAndConfigureHubPool,
  deployConfigStore,
  deploySpokePoolWithToken,
  destinationChainId,
  ethers,
  expect,
  originChainId,
  toBNWei,
  winston,
  zeroAddress,
} from "./utils";

let spokePool_1: Contract, spokePool_2: Contract;
let erc20_2: Contract;
let spokePoolClient_1: SpokePoolClient, spokePoolClient_2: SpokePoolClient;
let owner: SignerWithAddress, spyLogger: winston.Logger;
let tokenClient: TokenClient; // tested
let spokePool1DeploymentBlock: number, spokePool2DeploymentBlock: number;

describe("TokenClient: Token shortfall", async function () {
  beforeEach(async function () {
    [owner] = await ethers.getSigners();
    ({ spyLogger } = createSpyLogger());
    // Using deploySpokePoolWithToken will create two tokens and enable both of them as routes.
    ({ spokePool: spokePool_1, deploymentBlock: spokePool1DeploymentBlock } = await deploySpokePoolWithToken(
      originChainId,
      destinationChainId
    ));
    ({
      spokePool: spokePool_2,
      erc20: erc20_2,
      deploymentBlock: spokePool2DeploymentBlock,
    } = await deploySpokePoolWithToken(destinationChainId, originChainId));
    const { hubPool } = await deployAndConfigureHubPool(owner, [], zeroAddress, zeroAddress);
    const { configStore } = await deployConfigStore(owner, []);

    const configStoreClient = new MockConfigStoreClient(createSpyLogger().spyLogger, configStore);

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
    const hubPoolClient = new HubPoolClient(createSpyLogger().spyLogger, hubPool, configStoreClient);

    tokenClient = new TokenClient(spyLogger, owner.address, spokePoolClients, hubPoolClient);
  });

  it("Captures and tracks token shortfall", async function () {
    await updateAllClients();
    expect(tokenClient.getTokenShortfall()).to.deep.equal({});

    // Mint token balance to 69. Try and fill a deposit of 420. There should be a token shortfall of 420-69 = 351.
    const balance = toBNWei(69);
    await erc20_2.mint(owner.address, balance);
    await updateAllClients();
    const depositId = 1;
    let needed = toBNWei(420);
    let shortfall = needed.sub(balance);
    tokenClient.captureTokenShortfall(destinationChainId, erc20_2.address, depositId, toBNWei(420));
    const tokenShortFallData = tokenClient.getTokenShortfall()[destinationChainId][erc20_2.address];
    expect(tokenShortFallData.balance).to.equal(balance);
    expect(tokenShortFallData.needed).to.equal(needed);
    expect(tokenShortFallData.shortfall).to.equal(shortfall);
    expect(tokenShortFallData.deposits).to.deep.equal([depositId]);

    // A subsequent shortfall deposit of 42 should add to the token shortfall and append the deposit id as 351+42 = 393.
    const depositId2 = 2;

    tokenClient.captureTokenShortfall(destinationChainId, erc20_2.address, depositId2, toBNWei(42));
    needed = needed.add(toBNWei(42));
    shortfall = needed.sub(balance);
    const tokenShortFallData2 = tokenClient.getTokenShortfall()[destinationChainId][erc20_2.address];
    expect(tokenShortFallData2.balance).to.equal(balance);
    expect(tokenShortFallData2.needed).to.equal(needed);
    expect(tokenShortFallData2.shortfall).to.equal(shortfall);
    expect(tokenShortFallData2.deposits).to.deep.equal([depositId, depositId2]);

    // Updating the client should not impact anything.
    await updateAllClients();
    expect(tokenShortFallData2).to.deep.equal(tokenClient.getTokenShortfall()[destinationChainId][erc20_2.address]);
  });
});

async function updateAllClients() {
  await spokePoolClient_1.update();
  await spokePoolClient_2.update();
  await tokenClient.update();
}
