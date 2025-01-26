import { SpokePoolClient, TokenClient } from "../src/clients";
import { MockConfigStoreClient, MockHubPoolClient } from "./mocks";
import { originChainId, destinationChainId, ZERO_ADDRESS } from "./constants";
import {
  BigNumber,
  Contract,
  SignerWithAddress,
  createSpyLogger,
  deployAndConfigureHubPool,
  deployConfigStore,
  deploySpokePoolWithToken,
  ethers,
  expect,
  toBNWei,
  winston,
} from "./utils";

describe("TokenClient: Token shortfall", async function () {
  let spokePool_1: Contract, spokePool_2: Contract;
  let erc20_2: Contract;
  let spokePoolClient_1: SpokePoolClient, spokePoolClient_2: SpokePoolClient;
  let owner: SignerWithAddress, spyLogger: winston.Logger;
  let tokenClient: TokenClient; // tested
  let spokePool1DeploymentBlock: number, spokePool2DeploymentBlock: number;

  const updateAllClients = async () => {
    await spokePoolClient_1.update();
    await spokePoolClient_2.update();
    await tokenClient.update();
  };

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
    const { hubPool, l1Token_1 } = await deployAndConfigureHubPool(owner, [], ZERO_ADDRESS, ZERO_ADDRESS);
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

    const spokePoolClients = { [originChainId]: spokePoolClient_1, [destinationChainId]: spokePoolClient_2 };
    const hubPoolClient = new MockHubPoolClient(createSpyLogger().spyLogger, hubPool, configStoreClient);

    hubPoolClient.addL1Token({
      symbol: await l1Token_1.symbol(),
      decimals: await l1Token_1.decimals(),
      address: l1Token_1.address,
    });
    hubPoolClient.setTokenMapping(l1Token_1.address, destinationChainId, erc20_2.address);

    tokenClient = new TokenClient(spyLogger, owner.address, spokePoolClients, hubPoolClient);
  });

  it("Captures and tracks token shortfall", async function () {
    await updateAllClients();
    expect(tokenClient.getTokenShortfall()).to.deep.equal({});

    // Mint token balance to 69. Try and fill a deposit of 420. There should be a token shortfall of 420-69 = 351.
    const balance = toBNWei(69);
    await erc20_2.mint(owner.address, balance);
    await updateAllClients();
    const depositId = BigNumber.from(1);
    let needed = toBNWei(420);
    let shortfall = needed.sub(balance);
    tokenClient.captureTokenShortfall(destinationChainId, erc20_2.address, depositId, toBNWei(420));
    const tokenShortFallData = tokenClient.getTokenShortfall()[destinationChainId][erc20_2.address];
    expect(tokenShortFallData.balance).to.equal(balance);
    expect(tokenShortFallData.needed).to.equal(needed);
    expect(tokenShortFallData.shortfall).to.equal(shortfall);
    expect(tokenShortFallData.deposits).to.deep.equal([depositId]);

    // A subsequent shortfall deposit of 42 should add to the token shortfall and append the deposit id as 351+42 = 393.
    const depositId2 = BigNumber.from(2);

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
