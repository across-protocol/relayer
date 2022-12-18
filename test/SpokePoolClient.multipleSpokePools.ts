import {
  expect,
  ethers,
  Contract,
  SignerWithAddress,
  setupTokensForWallet,
  createSpyLogger,
  deployAndConfigureHubPool,
  enableRoutesOnHubPool,
} from "./utils";
import { deploySpokePoolWithToken, enableRoutes, simpleDeposit, originChainId, destinationChainId } from "./utils";

import { HubPoolClient, SpokePoolClient } from "../src/clients";
import { setupUmaEcosystem } from "./fixtures/UmaEcosystemFixture";

let spokePool: Contract, erc20: Contract, destErc20: Contract, weth: Contract, l1Token_1: Contract;
let owner: SignerWithAddress, depositor1: SignerWithAddress, depositor2: SignerWithAddress;
const destinationChainId2 = destinationChainId + 1;

let spokePoolClient: SpokePoolClient, hubPoolClient: HubPoolClient;

async function updateSpokePoolClient(_spokePoolClient: SpokePoolClient) {
  await hubPoolClient.update();
  await _spokePoolClient.update();
}

describe("SpokePoolClient: Handle events from historically activated SpokePools", async function () {
  beforeEach(async function () {
    [owner, depositor1, depositor2] = await ethers.getSigners();
    ({ spokePool, erc20, destErc20, weth } = await deploySpokePoolWithToken(originChainId));
    await enableRoutes(spokePool, [{ originToken: erc20.address, destinationChainId: destinationChainId2 }]);
    const { hubPool, l1Token_1 } = await deployAndConfigureHubPool(owner, [{ l2ChainId: originChainId, spokePool }]);
    await enableRoutesOnHubPool(hubPool, [
      { destinationChainId: originChainId, l1Token: l1Token_1, destinationToken: erc20 },
      {
        destinationChainId: (await hubPool.provider.getNetwork()).chainId,
        l1Token: l1Token_1,
        destinationToken: l1Token_1,
      },
    ]);

    const spyLogger = createSpyLogger().spyLogger;
    hubPoolClient = new HubPoolClient(spyLogger, hubPool, (await hubPool.provider.getNetwork()).chainId);

    spokePoolClient = new SpokePoolClient(spyLogger, spokePool, hubPoolClient, null, originChainId);

    await setupTokensForWallet(spokePool, depositor1, [erc20, destErc20], weth, 10);
    await setupTokensForWallet(spokePool, depositor2, [erc20, destErc20], weth, 10);
    await updateSpokePoolClient(spokePoolClient);
  });

  it("getSpokePools", async function () {
    const spokePools = await spokePoolClient.getSpokePools();
    expect(spokePools.length).to.equal(1);
    expect(spokePools[0].spokePool).to.equal(spokePool.address);

    // Upgrade spoke pool and check activeBlocks are set correctly for both spoke pools
    // - First one should have toBlock equal to upgrade event
    // - Second one should have fromBlock equal to upgrade event
  });

  it("Can fetch deposits from two spoke pools", async function () {
    // Send a deposit on first spoke pool.
    const deposit1 = await simpleDeposit(spokePool, erc20, depositor1, depositor1, destinationChainId);
    await updateSpokePoolClient(spokePoolClient);

    // Upgrade spoke pool to new one.
    // Send a deposit on second spoke pool.

    // Update SpokePoolClient with range large enough to cover both deposits.
  });
});
