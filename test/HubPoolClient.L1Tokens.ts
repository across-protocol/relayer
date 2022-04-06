import { getContractFactory, expect, ethers, Contract, SignerWithAddress, zeroAddress, createSpyLogger } from "./utils";

import { HubPoolClient } from "../src/clients"; // Tested

let hubPool: Contract, lpTokenFactory: Contract;
let owner: SignerWithAddress;
let hubPoolClient: HubPoolClient;

describe("HubPoolClient: L1Tokens", async function () {
  beforeEach(async function () {
    [owner] = await ethers.getSigners();

    lpTokenFactory = await (await getContractFactory("LpTokenFactory", owner)).deploy();

    hubPool = await (
      await getContractFactory("HubPool", owner)
    ).deploy(lpTokenFactory.address, zeroAddress, zeroAddress, zeroAddress);

    hubPoolClient = new HubPoolClient(createSpyLogger().spyLogger, hubPool);
  });

  it("Fetches all L1Tokens Addresses", async function () {
    await hubPoolClient.update();
    expect(hubPoolClient.getL1Tokens()).to.deep.equal([]);

    const l1Token1 = await (await getContractFactory("ExpandedERC20", owner)).deploy("Yeet Coin1", "Coin", 18);
    const l1Token2 = await (await getContractFactory("ExpandedERC20", owner)).deploy("Yeet Coin2", "Coin", 18);
    const l1Token3 = await (await getContractFactory("ExpandedERC20", owner)).deploy("Yeet Coin3", "Coin", 18);
    await hubPool.connect(owner).enableL1TokenForLiquidityProvision(l1Token1.address);
    await hubPool.connect(owner).enableL1TokenForLiquidityProvision(l1Token2.address);
    await hubPool.connect(owner).enableL1TokenForLiquidityProvision(l1Token3.address);

    await hubPoolClient.update();
    expect(hubPoolClient.getL1Tokens()).to.deep.equal([l1Token1.address, l1Token2.address, l1Token3.address]);
  });
});
