import { expect, toBNWei, ethers, Contract, SignerWithAddress, setupTokensForWallet } from "./utils";
import { deployAndEnableSpokePool, fillRelay, deposit, originChainId, destinationChainId } from "./utils";

import { SpokePoolEventClient } from "../src/SpokePoolEventClient";

let spokePool_1: Contract, erc20_1: Contract, spokePool_2: Contract, erc20_2: Contract;
let owner: SignerWithAddress, depositor: SignerWithAddress, relayer: SignerWithAddress;

let spokePoolClient: SpokePoolEventClient;

describe("SpokePoolEventClient: Validate Fill", async function () {
  beforeEach(async function () {
    [owner, depositor, relayer] = await ethers.getSigners();
    // Creat two spoke pools: one to act as the source and the other to act as the destination.
    ({ spokePool: spokePool_1, erc20: erc20_1 } = await deployAndEnableSpokePool(originChainId, destinationChainId));
    ({ spokePool: spokePool_2, erc20: erc20_2 } = await deployAndEnableSpokePool(destinationChainId, originChainId));
    spokePoolClient = new SpokePoolEventClient(spokePool_2, originChainId); // create spoke pool client on the "target" chain.

    await setupTokensForWallet(spokePool_1, depositor, [erc20_1], null, 10);
    await setupTokensForWallet(spokePool_2, relayer, [erc20_2], null, 10);
  });

  it("Accepts valid fills", async function () {
    const deposit_1 = await deposit(spokePool_1, erc20_1, depositor, depositor, destinationChainId);
    const fill_1 = await fillRelay(spokePool_2, erc20_2, depositor, depositor, relayer, 0, originChainId);
    expect(spokePoolClient.validateFillForDeposit(fill_1, deposit_1)).to.equal(true);
  });

  it("Rejects fills that dont match the deposit data", async function () {
    const deposit_1 = await deposit(spokePool_1, erc20_1, depositor, depositor, destinationChainId);
    const validFill = await fillRelay(spokePool_2, erc20_2, depositor, depositor, relayer, 0, originChainId);

    // Invalid Amount.
    expect(spokePoolClient.validateFillForDeposit({ ...validFill, amount: toBNWei(1337) }, deposit_1)).to.be.false;

    // Invalid depositId.
    expect(spokePoolClient.validateFillForDeposit({ ...validFill, depositId: 1337 }, deposit_1)).to.be.false;

    // Changed the depositor.
    expect(spokePoolClient.validateFillForDeposit({ ...validFill, depositor: relayer.address }, deposit_1)).to.be.false;

    // Changed the recipient.
    expect(spokePoolClient.validateFillForDeposit({ ...validFill, recipient: relayer.address }, deposit_1)).to.be.false;

    // Changed the relayerFeePct.
    expect(spokePoolClient.validateFillForDeposit({ ...validFill, relayerFeePct: toBNWei(1337) }, deposit_1)).to.be
      .false;

    // Changes to the realizedLpFeePct or destinationToken should NOT be verified in the current state of the code.
    // TODO: add a test for this when we have async support for this validation and when the HubPool can verify these.
    expect(spokePoolClient.validateFillForDeposit({ ...validFill, realizedLpFeePct: toBNWei(1337) }, deposit_1)).to.be
      .true;

    expect(spokePoolClient.validateFillForDeposit({ ...validFill, destinationToken: relayer.address }, deposit_1)).to.be
      .true;
  });
});
