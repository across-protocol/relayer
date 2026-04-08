import { expect } from "chai";
import { ethers } from "ethers";
import { getCloidForTimestampAndAccount } from "../src/rebalancer/utils/cloid";

describe("RebalancerClient.cloid", () => {
  it("derives distinct 16-byte cloids for different relayer accounts at the same timestamp", async () => {
    const fixedTimestamp = 1_234_567_890;
    const signerA = ethers.Wallet.createRandom();
    const signerB = ethers.Wallet.createRandom();
    const accountA = await signerA.getAddress();
    const accountB = await signerB.getAddress();

    const cloidA = getCloidForTimestampAndAccount(fixedTimestamp, accountA);
    const cloidB = getCloidForTimestampAndAccount(fixedTimestamp, accountB);

    expect(cloidA).to.match(/^0x[0-9a-f]{32}$/);
    expect(cloidB).to.match(/^0x[0-9a-f]{32}$/);
    expect(cloidA).to.not.equal(cloidB);
  });

  it("is deterministic for the same relayer account and timestamp", async () => {
    const fixedTimestamp = 1_234_567_890;
    const signer = ethers.Wallet.createRandom();
    const account = await signer.getAddress();

    expect(getCloidForTimestampAndAccount(fixedTimestamp, account)).to.equal(
      getCloidForTimestampAndAccount(fixedTimestamp, account)
    );
  });
});
