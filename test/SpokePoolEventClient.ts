import { expect, ethers, Contract, SignerWithAddress } from "@across-protocol/contracts-v2/test/utils";
import { spokePoolFixture } from "./fixtures/SpokePool.Fixture";
import { destinationChainId } from "@across-protocol/contracts-v2/test/constants";

import { SpokePoolEventClient } from "../src/SpokePoolEventClient";

let spokePool: Contract, erc20: Contract;
let owner: SignerWithAddress;

let spokePoolClient: any;

describe("SpokePoolEventClient", async function () {
  beforeEach(async function () {
    [owner] = await ethers.getSigners();
    ({ spokePool, erc20 } = await spokePoolFixture());

    spokePoolClient = new SpokePoolEventClient(ethers.provider, 0, spokePool.address);
  });
  it("Correctly fetches deposit data", async function () {});
});
