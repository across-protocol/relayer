import { Disputer } from "../src/dataworker/Disputer";
import { BigNumber, bnUint256Max, bnZero, bnOne, toBNWei, ZERO_BYTES } from "../src/utils";
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

// Exposes the bond multiples so tests can assert against them instead of duplicating the literals.
class TestDisputer extends Disputer {
  get multiplier(): { min: number; target: number } {
    return this.bondMultiplier;
  }
}

// Overwrite an account's native balance; used to drive validate()'s insufficient-balance branches.
async function setNativeBalance(address: string, amount: BigNumber): Promise<void> {
  // hardhat_setBalance takes a QUANTITY, which must not carry leading zeroes.
  await ethers.provider.send("hardhat_setBalance", [address, amount.toHexString().replace(/^0x0+(.)/, "0x$1")]);
}

describe("Disputer: Watchdog", function () {
  let chainId: number;
  const simulate = false;
  const bondAmount = toBNWei(1);

  let hubPool: Contract, bondToken: Contract;
  let owner: SignerWithAddress, signer: SignerWithAddress, poorSigner: SignerWithAddress;
  let logger: winston.Logger;
  let disputer: TestDisputer;
  let signerAddr: string;

  beforeEach(async function () {
    ({ spyLogger: logger } = createSpyLogger());
    [owner, signer, poorSigner] = await ethers.getSigners();
    signerAddr = await signer.getAddress();

    const umaEcosystem = await setupUmaEcosystem(owner);
    ({ hubPool } = await deployAndConfigureHubPool(owner, [], umaEcosystem.finder.address, umaEcosystem.timer.address));

    ({ chainId } = await hubPool.provider.getNetwork());

    bondToken = await (await getContractFactory("BondToken", owner)).deploy(hubPool.address);
    await bondToken.setProposer(signerAddr, true);
    await bondToken.setProposer(await poorSigner.getAddress(), true);
    await umaEcosystem.collateralWhitelist.addToWhitelist(bondToken.address);
    await umaEcosystem.store.setFinalFee(bondToken.address, { rawValue: toBNWei("0.1") });
    await hubPool.setBond(bondToken.address, bondAmount);

    disputer = new TestDisputer(chainId, logger, hubPool, signer, simulate);
    await disputer.validate();
  });

  it("Disputer::validate mints up to the target multiple", async function () {
    // validate() runs in beforeEach; the balance must land on the target multiple, not the minimum.
    // hubPool.bondAmount() is the configured bond plus the UMA final fee.
    const balance = await bondToken.balanceOf(signerAddr);
    expect(balance.eq((await hubPool.bondAmount()).mul(disputer.multiplier.target))).to.be.true;
  });

  it("Disputer::validate mints what it can afford when the target is out of reach", async function () {
    // Enough native token for several bonds, but short of the full target top-up; mint anyway.
    const poorAddr = await poorSigner.getAddress();
    const nativeBalance = (await hubPool.bondAmount()).mul(3);
    await setNativeBalance(poorAddr, nativeBalance);

    const poorDisputer = new TestDisputer(chainId, logger, hubPool, poorSigner, simulate);
    await poorDisputer.validate();

    const balance = await bondToken.balanceOf(poorAddr);
    expect(balance.gte(await hubPool.bondAmount())).to.be.true;
    expect(balance.lt((await hubPool.bondAmount()).mul(poorDisputer.multiplier.target))).to.be.true;
    // Gas money must survive the mint, otherwise the dispute itself can't be submitted.
    expect((await ethers.provider.getBalance(poorAddr)).gt(bnZero)).to.be.true;
  });

  it("Disputer::validate throws when it can't cover a single bond", async function () {
    // Below one bond even after minting everything available: the watchdog can't dispute, so fail loudly.
    const poorAddr = await poorSigner.getAddress();
    await setNativeBalance(poorAddr, (await hubPool.bondAmount()).div(2));

    const poorDisputer = new TestDisputer(chainId, logger, hubPool, poorSigner, simulate);
    await expect(poorDisputer.validate()).to.be.rejectedWith("Insufficient native token balance");
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
