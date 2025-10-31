import { Disputer } from "../src/dataworker/Disputer";
import { bnUint256Max, bnZero, bnOne, toBNWei, ZERO_BYTES } from "../src/utils";
import { setupUmaEcosystem } from "./fixtures/UmaEcosystemFixture";
import {
  BigNumber,
  Contract,
  createSpyLogger,
  deployAndConfigureHubPool,
  ethers,
  expect,
  getContractFactory,
  SignerWithAddress,
  winston,
} from "./utils";

class TestDisputer extends Disputer {
  allowance(): Promise<BigNumber> {
    return super.allowance();
  }

  balance(): Promise<BigNumber> {
    return super.balance();
  }

  approve(amount: BigNumber): Promise<void> {
    return super.approve(amount);
  }

  mintBond(amount: BigNumber): Promise<void> {
    return super.mintBond(amount);
  }
}

describe("Disputer: Watchdog", async function () {
  let chainId: number;
  const simulate = false;
  const bondAmount = toBNWei(1);

  let hubPool: Contract, bondToken: Contract;
  let owner: SignerWithAddress, signer: SignerWithAddress;
  let logger: winston.Logger;
  let disputer: TestDisputer;
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
    // await bondToken.addMember(TokenRolesEnum.MINTER, owner.address);

    await umaEcosystem.collateralWhitelist.addToWhitelist(bondToken.address);
    await umaEcosystem.store.setFinalFee(bondToken.address, { rawValue: toBNWei("0.1") });
    await hubPool.setBond(bondToken.address, bondAmount);

    // Approve bondToken on itself to appease `setupTokensForWallet()`.
    disputer = new TestDisputer(chainId, logger, hubPool, signer, simulate);
    await disputer.init();
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
