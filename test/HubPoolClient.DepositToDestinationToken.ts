import { getContractFactory, expect, ethers, Contract, SignerWithAddress, originChainId } from "./utils";
import { zeroAddress, destinationChainId, toBN, deployRateModelStore, contractAt, createSpyLogger } from "./utils";
import { randomLl1Token, randomOriginToken, randomDestinationToken, randomDestinationToken2 } from "./constants";
import { HubPoolClient } from "../src/clients/HubPoolClient";

let hubPool: Contract, lpTokenFactory: Contract, mockAdapter: Contract, rateModelStore: Contract;
let owner: SignerWithAddress;
let hubPoolClient: HubPoolClient;

describe("HubPoolClient: Deposit to Destination Token", async function () {
  beforeEach(async function () {
    [owner] = await ethers.getSigners();

    // Deploy minimal hubPool. Don't configure the finder, timer or weth addresses as unrelated for this test file.
    lpTokenFactory = await (await getContractFactory("LpTokenFactory", owner)).deploy();
    hubPool = await (
      await getContractFactory("HubPool", owner)
    ).deploy(lpTokenFactory.address, zeroAddress, zeroAddress, zeroAddress);

    mockAdapter = await (await getContractFactory("Mock_Adapter", owner)).deploy();
    await hubPool.setCrossChainContracts(originChainId, mockAdapter.address, zeroAddress);

    ({ rateModelStore } = await deployRateModelStore(owner, [await contractAt("ERC20", owner, randomLl1Token)]));

    hubPoolClient = new HubPoolClient(createSpyLogger().spyLogger, hubPool);
  });

  it("Correctly appends whitelisted routes to the client", async function () {
    await hubPoolClient.update();
    expect(hubPoolClient.getL1TokensToDestinationTokens()).to.deep.equal({});

    await hubPool.setPoolRebalanceRoute(destinationChainId, randomLl1Token, randomDestinationToken);
    await hubPool.setPoolRebalanceRoute(originChainId, randomLl1Token, randomOriginToken);
    await hubPoolClient.update();
    expect(hubPoolClient.getL1TokensToDestinationTokens()).to.deep.equal({
      [randomLl1Token]: { [destinationChainId]: randomDestinationToken, [originChainId]: randomOriginToken },
    });

    const depositData = {
      depositId: 0,
      depositor: owner.address,
      recipient: owner.address,
      originToken: randomOriginToken,
      destinationToken: zeroAddress,
      realizedLpFeePct: toBN(0),
      amount: toBN(1337),
      originChainId,
      destinationChainId,
      relayerFeePct: toBN(1337),
      quoteTimestamp: 1234,
    };
    expect(hubPoolClient.getDestinationTokenForDeposit(depositData)).to.equal(randomDestinationToken);

    // Now try changing the destination token. Client should correctly handel this.
    await hubPool.setPoolRebalanceRoute(destinationChainId, randomLl1Token, randomDestinationToken2);
    await hubPoolClient.update();
    expect(hubPoolClient.getL1TokensToDestinationTokens()).to.deep.equal({
      [randomLl1Token]: { [destinationChainId]: randomDestinationToken2, [originChainId]: randomOriginToken },
    });

    expect(hubPoolClient.getDestinationTokenForDeposit(depositData)).to.equal(randomDestinationToken2);
  });
});
