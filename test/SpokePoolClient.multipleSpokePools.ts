import {
  expect,
  ethers,
  Contract,
  SignerWithAddress,
  setupTokensForWallet,
  createSpyLogger,
  deployAndConfigureHubPool,
  enableRoutesOnHubPool,
  winston,
  assert,
} from "./utils";
import { deploySpokePoolWithToken, enableRoutes, simpleDeposit, originChainId, destinationChainId } from "./utils";

import { HubPoolClient, SpokePoolClient } from "../src/clients";

let spokePool: Contract, erc20: Contract, destErc20: Contract, weth: Contract, l1Token_1: Contract, hubPool: Contract;
let owner: SignerWithAddress, depositor1: SignerWithAddress, depositor2: SignerWithAddress;
let setCrossChainContractsTxn: any[];
let mockAdapter: Contract, spyLogger: winston.Logger;
const destinationChainId2 = destinationChainId + 1;

let spokePoolClient: SpokePoolClient, hubPoolClient: HubPoolClient;

async function updateSpokePoolClient(_spokePoolClient: SpokePoolClient) {
  await hubPoolClient.update();
  await _spokePoolClient.update();
}

async function deployNewSpokePool(_originChain, _destChain) {
  const deploymentParams = await deploySpokePoolWithToken(_originChain);
  await enableRoutes(deploymentParams.spokePool, [
    { originToken: deploymentParams.erc20.address, destinationChainId: _destChain },
  ]);
  return deploymentParams;
}

describe("SpokePoolClient: Handle events from historically activated SpokePools", async function () {
  beforeEach(async function () {
    [owner, depositor1, depositor2] = await ethers.getSigners();
    ({ spokePool, erc20, destErc20, weth } = await deployNewSpokePool(originChainId, destinationChainId2));
    ({ hubPool, l1Token_1, mockAdapter, setCrossChainContractsTxn } = await deployAndConfigureHubPool(owner, [
      { l2ChainId: originChainId, spokePool },
    ]));
    await enableRoutesOnHubPool(hubPool, [
      { destinationChainId: originChainId, l1Token: l1Token_1, destinationToken: erc20 },
      {
        destinationChainId: (await hubPool.provider.getNetwork()).chainId,
        l1Token: l1Token_1,
        destinationToken: l1Token_1,
      },
    ]);

    spyLogger = createSpyLogger().spyLogger;
    hubPoolClient = new HubPoolClient(spyLogger, hubPool, (await hubPool.provider.getNetwork()).chainId);

    spokePoolClient = new SpokePoolClient(spyLogger, spokePool, hubPoolClient, null, originChainId);

    await setupTokensForWallet(spokePool, depositor1, [erc20, destErc20], weth, 10);
    await setupTokensForWallet(spokePool, depositor2, [erc20, destErc20], weth, 10);
    await updateSpokePoolClient(spokePoolClient);
  });

  it("getSpokePools", async function () {
    let spokePools = await spokePoolClient.getSpokePools();
    expect(spokePools.length).to.equal(1);
    expect(spokePools[0].spokePool).to.equal(spokePool.address);
    expect(spokePools[0].activeBlocks).to.deep.equal({
      fromBlock: setCrossChainContractsTxn[0].blockNumber,
      toBlock: spokePoolClient.latestBlockNumber,
    });

    // Upgrade spoke pool and check activeBlocks are set correctly for both spoke pools
    const upgradedSpokePool = await deployNewSpokePool(originChainId, destinationChainId2);
    const upgradeTxn = await hubPool.setCrossChainContracts(
      originChainId,
      mockAdapter.address,
      upgradedSpokePool.spokePool.address
    );

    // Updating spoke pool client without updating the default spoke pool contract should throw an error.
    try {
      await updateSpokePoolClient(spokePoolClient);
      assert.fail();
    } catch (err) {
      assert.ok(err);
    }

    // Create new spoke pool client with upgraded spoke pool contract.
    spokePoolClient = new SpokePoolClient(spyLogger, upgradedSpokePool.spokePool, hubPoolClient, null, originChainId);
    await updateSpokePoolClient(spokePoolClient);
    spokePools = await spokePoolClient.getSpokePools();
    expect(spokePools.length).to.equal(2);
    expect(spokePools[0].activeBlocks).to.deep.equal({
      fromBlock: setCrossChainContractsTxn[0].blockNumber,
      toBlock: upgradeTxn.blockNumber - 1,
    });
    expect(spokePools[1].activeBlocks).to.deep.equal({
      fromBlock: upgradeTxn.blockNumber,
      toBlock: spokePoolClient.latestBlockNumber,
    });
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
