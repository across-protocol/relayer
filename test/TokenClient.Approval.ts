import { deploySpokePoolWithToken, expect, ethers, Contract, SignerWithAddress, MAX_SAFE_ALLOWANCE } from "./utils";
import { createSpyLogger, winston, originChainId, destinationChainId, lastSpyLogIncludes } from "./utils";
import { TokenClient, SpokePoolClient } from "../src/clients";

let spokePool_1: Contract, spokePool_2: Contract;
let erc20_1: Contract, weth_1: Contract, erc20_2: Contract, weth_2: Contract;
let spokePoolClient_1: SpokePoolClient, spokePoolClient_2: SpokePoolClient;
let owner: SignerWithAddress, spy: sinon.SinonSpy, spyLogger: winston.Logger;
let tokenClient: TokenClient; // tested

describe("TokenClient: Origin token approval", async function () {
  beforeEach(async function () {
    [owner] = await ethers.getSigners();
    ({ spy, spyLogger } = createSpyLogger());
    // Using deploySpokePoolWithToken will create two tokens and enable both of them as routes.
    ({
      spokePool: spokePool_1,
      erc20: erc20_1,
      weth: weth_1,
    } = await deploySpokePoolWithToken(originChainId, destinationChainId));
    ({
      spokePool: spokePool_2,
      erc20: erc20_2,
      weth: weth_2,
    } = await deploySpokePoolWithToken(destinationChainId, originChainId));

    spokePoolClient_1 = new SpokePoolClient(createSpyLogger().spyLogger, spokePool_1, null, originChainId);
    spokePoolClient_2 = new SpokePoolClient(createSpyLogger().spyLogger, spokePool_2, null, destinationChainId);

    const spokePoolClients = { [destinationChainId]: spokePoolClient_1, [originChainId]: spokePoolClient_2 };

    tokenClient = new TokenClient(spyLogger, owner.address, spokePoolClients);
  });

  it("Executes expected token approvals and produces logs", async function () {
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
    expect(await erc20_1.allowance(owner.address, spokePool_2.address)).to.equal(MAX_SAFE_ALLOWANCE);
    expect(await erc20_2.allowance(owner.address, spokePool_1.address)).to.equal(MAX_SAFE_ALLOWANCE);
    expect(await weth_1.allowance(owner.address, spokePool_2.address)).to.equal(MAX_SAFE_ALLOWANCE);
    expect(await weth_2.allowance(owner.address, spokePool_1.address)).to.equal(MAX_SAFE_ALLOWANCE);
  });
});

async function updateAllClients() {
  await spokePoolClient_1.update();
  await spokePoolClient_2.update();
  await tokenClient.update();
}
