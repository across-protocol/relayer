import { expect, toBNWei, ethers, Contract, SignerWithAddress, setupTokensForWallet } from "./utils";
import { deploySpokePoolWithToken, fillRelay, deposit, originChainId, destinationChainId } from "./utils";

import { SpokePoolClient } from "../src/clients/SpokePoolClient";

let spokePool_1: Contract, erc20_1: Contract, spokePool_2: Contract, erc20_2: Contract;
let owner: SignerWithAddress, depositor: SignerWithAddress, relayer: SignerWithAddress;

let spokePoolClient: SpokePoolClient;

describe("SpokePoolClient: Fill Validation", async function () {
  beforeEach(async function () {
    [owner, depositor, relayer] = await ethers.getSigners();
    // Creat two spoke pools: one to act as the source and the other to act as the destination.
    ({ spokePool: spokePool_1, erc20: erc20_1 } = await deploySpokePoolWithToken(originChainId, destinationChainId));
    ({ spokePool: spokePool_2, erc20: erc20_2 } = await deploySpokePoolWithToken(destinationChainId, originChainId));
    spokePoolClient = new SpokePoolClient(spokePool_2, null, originChainId); // create spoke pool client on the "target" chain.

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

    // Validate the realizedLPFeePct and destinationToken matches. These values are optional in the deposit object and
    // are assigned during the update method, which is not polled in this set of tests.

    // Assign a realizedLPFeePct to the deposit and check it matches with the fill. The default set on a fill (from
    // contracts-v2) is 0.1. After, try changing this to a separate value and ensure this is rejected.
    expect(spokePoolClient.validateFillForDeposit(validFill, { ...deposit_1, realizedLpFeePct: toBNWei(0.1) })).to.be
      .true;

    expect(spokePoolClient.validateFillForDeposit(validFill, { ...deposit_1, realizedLpFeePct: toBNWei(0.1337) })).to.be
      .false;

    // Assign a destinationToken to the deposit and ensure it is validated correctly. erc20_2 from the fillRelay method
    // above is the destination token. After, try changing this to something that is clearly wrong.
    expect(spokePoolClient.validateFillForDeposit(validFill, { ...deposit_1, destinationToken: erc20_2.address })).to.be
      .true;
    expect(spokePoolClient.validateFillForDeposit(validFill, { ...deposit_1, destinationToken: owner.address })).to.be
      .false;
  });
});
