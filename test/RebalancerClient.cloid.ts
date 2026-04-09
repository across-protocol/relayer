import { expect } from "chai";
import { ethers } from "ethers";
import { getCloidForAccount } from "../src/rebalancer/utils/utils";
import { delay } from "../src/utils";

describe("RebalancerClient.cloid", () => {
  it("derives distinct 16-byte cloids for different relayer accounts at different timestamps", async () => {
    const signerA = ethers.Wallet.createRandom();
    const signerB = ethers.Wallet.createRandom();
    const accountA = await signerA.getAddress();
    const accountB = await signerB.getAddress();

    const cloidA = getCloidForAccount(accountA);
    await delay(1);
    const cloidB = getCloidForAccount(accountB);

    expect(cloidA).to.match(/^0x[0-9a-f]{32}$/);
    expect(cloidB).to.match(/^0x[0-9a-f]{32}$/);
    expect(cloidA).to.not.equal(cloidB);
  });
});
