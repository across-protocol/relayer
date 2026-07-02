import { Disputer } from "../src/dataworker/Disputer";
import { bnUint256Max, bnZero, bnOne, toBNWei, ZERO_BYTES } from "../src/utils";
import { setupUmaEcosystem } from "./fixtures/UmaEcosystemFixture";
import {
  Contract,
  createSpyLogger,
  deployAndConfigureHubPool,
  ethers,
  expect,
  getContractFactory,
  SignerWithAddress,
  winston,
} from "./utils";

describe("Disputer: Watchdog", function () {
  let chainId: number;
  const simulate = false;
  const bondAmount = toBNWei(1);

  let hubPool: Contract, bondToken: Contract;
  let owner: SignerWithAddress, signer: SignerWithAddress;
  let logger: winston.Logger;
  let disputer: Disputer;
  let signerAddr: string;

  beforeEach(async function () {
    ({ spyLogger: logger } = createSpyLogger());
    [owner, signer] = await ethers.getSigners();
    signerAddr = await signer.getAddress();

    const umaEcosystem = await setupUmaEcosystem(owner);
    ({ hubPool } = await deployAndConfigureHubPool(owner, [], umaEcosystem.finder.address, umaEcosystem.timer.address));

    ({ chainId } = await hubPool.provider.getNetwork());

    bondToken = await (await getContractFactory("BondToken", owner)).deploy(hubPool.address);
    await bondToken.setProposer(signerAddr, true);
    await umaEcosystem.collateralWhitelist.addToWhitelist(bondToken.address);
    await umaEcosystem.store.setFinalFee(bondToken.address, { rawValue: toBNWei("0.1") });
    await hubPool.setBond(bondToken.address, bondAmount);

    disputer = new Disputer(chainId, logger, hubPool, signer, simulate);
    await disputer.validate();
  });

  it("Disputer::validate tops up to the default target", async function () {
    // beforeEach validate() found a zero balance and topped up to the default target (8x bond).
    // Note: HubPool.setBond() stores the configured bond amount plus the OO final fee.
    const hubBond = await hubPool.bondAmount();
    const balance = await bondToken.balanceOf(signerAddr);
    expect(balance.eq(hubBond.mul(8))).to.be.true;

    // A subsequent validate() is a no-op: balance is at target, above the trigger.
    await disputer.validate();
    expect((await bondToken.balanceOf(signerAddr)).eq(balance)).to.be.true;
  });

  it("Disputer::validate respects configured trigger and target", async function () {
    const trigger = toBNWei(3);
    const target = toBNWei(5);
    const custom = new Disputer(chainId, logger, hubPool, signer, simulate, { trigger, target });

    // Balance (8x bond from beforeEach) is above the trigger; no mint.
    const initialBalance = await bondToken.balanceOf(signerAddr);
    await custom.validate();
    let balance = await bondToken.balanceOf(signerAddr);
    expect(balance.eq(initialBalance)).to.be.true;

    // Drain below the trigger; validate() restores the balance to target.
    await bondToken.connect(signer).transfer(await owner.getAddress(), balance);
    await custom.validate();
    balance = await bondToken.balanceOf(signerAddr);
    expect(balance.eq(target)).to.be.true;
  });

  it("Disputer::validate floors configured levels at the HubPool bond amount", async function () {
    // Trigger/target below the HubPool bond amount would leave the disputer unable to fund
    // disputeRootBundle(); both are floored at the bond amount.
    const hubBond = await hubPool.bondAmount();
    const custom = new Disputer(chainId, logger, hubPool, signer, simulate, {
      trigger: hubBond.div(4),
      target: hubBond.div(2),
    });

    let balance = await bondToken.balanceOf(signerAddr);
    await bondToken.connect(signer).transfer(await owner.getAddress(), balance);
    await custom.validate();
    balance = await bondToken.balanceOf(signerAddr);
    expect(balance.eq(hubBond)).to.be.true;
  });

  it("Disputer::validate wraps partially when native balance is insufficient", async function () {
    const trigger = toBNWei(3);
    const target = toBNWei(10);
    const custom = new Disputer(chainId, logger, hubPool, signer, simulate, { trigger, target });

    let balance = await bondToken.balanceOf(signerAddr);
    await bondToken.connect(signer).transfer(await owner.getAddress(), balance);

    const originalNativeBalance = await ethers.provider.getBalance(signerAddr);
    try {
      // 2.5 native available, 0.5 reserved for gas => only 2 of the 10 target can be wrapped.
      await ethers.provider.send("hardhat_setBalance", [signerAddr, toBNWei("2.5").toHexString()]);
      await custom.validate();
      balance = await bondToken.balanceOf(signerAddr);
      expect(balance.eq(toBNWei(2))).to.be.true;
    } finally {
      await ethers.provider.send("hardhat_setBalance", [signerAddr, originalNativeBalance.toHexString()]);
    }
  });

  it("Disputer::mintBond", async function () {
    let balance = await bondToken.balanceOf(signerAddr);
    expect(balance.gt(bnZero)).to.be.true;

    await bondToken.connect(signer).transfer(await owner.getAddress(), balance);
    balance = await bondToken.balanceOf(signerAddr);
    expect(balance.eq(bnZero)).to.be.true;

    await disputer.mintBond(bnOne);
    balance = await bondToken.balanceOf(signerAddr);
    expect(balance.eq(bnOne)).to.be.true;
  });

  it("Disputer::allowance", async function () {
    let allowance = await bondToken.allowance(signerAddr, hubPool.address);
    expect(allowance.eq(bnUint256Max)).to.be.true;

    allowance = await disputer.allowance();
    expect(allowance.eq(bnUint256Max)).to.be.true;

    await disputer.approve(bnZero);

    allowance = await disputer.allowance();
    expect(allowance.eq(bnZero)).to.be.true;
  });

  it("Disputer::approve", async function () {
    let allowance = await bondToken.allowance(signerAddr, hubPool.address);
    expect(allowance.gt(bnZero)).to.be.true;

    await bondToken.connect(signer).approve(hubPool.address, bnZero);
    allowance = await bondToken.allowance(signerAddr, hubPool.address);
    expect(allowance.eq(bnZero)).to.be.true;

    await disputer.approve(bnOne);
    allowance = await bondToken.allowance(signerAddr, hubPool.address);
    expect(allowance.eq(bnOne)).to.be.true;
  });

  it("Disputer::dispute", async function () {
    const balance = await bondToken.balanceOf(signerAddr);
    expect(balance.gte(bondAmount.mul(2))).to.be.true;

    const allowance = await bondToken.allowance(signerAddr, hubPool.address);
    expect(allowance.gte(bondAmount.mul(2))).to.be.true;

    // Propose an empty bundle.
    await hubPool.connect(signer).proposeRootBundle([], 1, ZERO_BYTES, ZERO_BYTES, ZERO_BYTES);

    const txnReceipt = await disputer.dispute();
    expect(txnReceipt).to.exist;
  });
});
