import { getContractFactory, expect, ethers, Contract, SignerWithAddress, originChainId } from "./utils";
import { zeroAddress, randomAddress, destinationChainId, toBN } from "./utils";
import { HubPoolEventClient } from "../src/HubPoolEventClient";

let hubPool: Contract, lpTokenFactory: Contract, mockAdapter: Contract;
let owner: SignerWithAddress;
let hubPoolClient: HubPoolEventClient;

const originToken = randomAddress();
const destinationToken = randomAddress();
const destinationToken2 = randomAddress();

describe("HubPoolEventClient: Whitelisted Routes", async function () {
  beforeEach(async function () {
    [owner] = await ethers.getSigners();

    // Deploy minimal hubPool. Dont configure the finder, timer or weth addresses as unrelated for this test file.
    lpTokenFactory = await (await getContractFactory("LpTokenFactory", owner)).deploy();
    hubPool = await (
      await getContractFactory("HubPool", owner)
    ).deploy(lpTokenFactory.address, zeroAddress, zeroAddress, zeroAddress);

    mockAdapter = await (await getContractFactory("Mock_Adapter", owner)).deploy();
    await hubPool.setCrossChainContracts(originChainId, mockAdapter.address, zeroAddress);

    hubPoolClient = new HubPoolEventClient(hubPool);
  });

  it("Correctly appends whitelisted routes to the client", async function () {
    await hubPoolClient.update();
    expect(hubPoolClient.getWhitelistedRoutes()).to.deep.equal({});

    await hubPool.whitelistRoute(originChainId, destinationChainId, originToken, destinationToken, true);
    await hubPoolClient.update();
    expect(hubPoolClient.getWhitelistedRoutes()).to.deep.equal({
      [originChainId]: { [originToken]: { [destinationChainId]: destinationToken } },
    });

    const deposit = {
      depositId: 0,
      depositor: owner.address,
      recipient: owner.address,
      originToken,
      amount: toBN(1337),
      originChainId,
      destinationChainId,
      relayerFeePct: toBN(1337),
      quoteTimestamp: 1234,
    };
    expect(hubPoolClient.getDestinationTokenForDeposit(deposit)).to.equal(destinationToken);
  });
  it("Re-whitelisting a route updates the mapping", async function () {
    await hubPool.whitelistRoute(originChainId, destinationChainId, originToken, destinationToken, true);
    await hubPool.whitelistRoute(originChainId, destinationChainId, originToken, destinationToken, false);
    await hubPool.whitelistRoute(originChainId, destinationChainId, originToken, destinationToken2, true);
    await hubPoolClient.update();
    expect(hubPoolClient.getWhitelistedRoutes()).to.deep.equal({
      [originChainId]: { [originToken]: { [destinationChainId]: destinationToken2 } },
    });
    // Calling update a second time changes nothing.
    await hubPoolClient.update();
    expect(hubPoolClient.getWhitelistedRoutes()).to.deep.equal({
      [originChainId]: { [originToken]: { [destinationChainId]: destinationToken2 } },
    });
  });
});
