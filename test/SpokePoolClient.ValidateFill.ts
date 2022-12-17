import {
  expect,
  toBNWei,
  ethers,
  fillRelay,
  SignerWithAddress,
  deposit,
  setupTokensForWallet,
  toBN,
  buildFill,
  buildModifiedFill,
  deploySpokePoolWithToken,
  Contract,
  originChainId,
  destinationChainId,
  createSpyLogger,
  zeroAddress,
  getLastBlockNumber,
} from "./utils";

import { SpokePoolClient } from "../src/clients";
import { MockHubPoolClient } from "./mocks";

let spokePool_1: Contract, erc20_1: Contract, spokePool_2: Contract, erc20_2: Contract;
let owner: SignerWithAddress, depositor: SignerWithAddress, relayer: SignerWithAddress;

let spokePoolClient2: SpokePoolClient;
let spokePoolClient1: SpokePoolClient;

describe("SpokePoolClient: Fill Validation", async function () {
  beforeEach(async function () {
    [owner, depositor, relayer] = await ethers.getSigners();
    // Creat two spoke pools: one to act as the source and the other to act as the destination.
    ({ spokePool: spokePool_1, erc20: erc20_1 } = await deploySpokePoolWithToken(originChainId, destinationChainId));
    ({ spokePool: spokePool_2, erc20: erc20_2 } = await deploySpokePoolWithToken(destinationChainId, originChainId));
    const { spyLogger } = createSpyLogger();
    const hubPoolClient = new MockHubPoolClient(null, null, null)
    spokePoolClient2 = new SpokePoolClient(createSpyLogger().spyLogger, spokePool_2, hubPoolClient, null, originChainId); // create spoke pool client on the "target" chain.
    spokePoolClient1 = new SpokePoolClient(spyLogger, spokePool_1, hubPoolClient, null, destinationChainId);

    await setupTokensForWallet(spokePool_1, depositor, [erc20_1], null, 10);
    await setupTokensForWallet(spokePool_2, relayer, [erc20_2], null, 10);
  });

  it("Accepts valid fills", async function () {
    await deposit(spokePool_1, erc20_1, depositor, depositor, destinationChainId);
    await fillRelay(spokePool_2, erc20_2, depositor, depositor, relayer, 0, originChainId);

    await spokePoolClient2.update();
    await spokePoolClient1.update();

    const [deposit_1] = spokePoolClient1.getDeposits();
    const [fill_1] = spokePoolClient2.getFills();

    // Some fields are expected to be dynamically populated by the client, but aren't in this environment.
    // Fill them in manually from the fill struct to get a valid comparison.
    expect(
      spokePoolClient2.validateFillForDeposit(fill_1, {
        ...deposit_1,
        realizedLpFeePct: fill_1.realizedLpFeePct,
        destinationToken: fill_1.destinationToken,
      })
    ).to.equal(true);
  });

  it("Returns deposit matched with fill", async function () {
    const deposit_1 = {
      ...(await deposit(spokePool_1, erc20_1, depositor, depositor, destinationChainId)),
      originBlockNumber: await getLastBlockNumber(),
      blockNumber: 0,
    };
    const fill_1 = await fillRelay(spokePool_2, erc20_2, depositor, depositor, relayer, 0, originChainId);

    const spokePoolClientForDestinationChain = new SpokePoolClient(
      createSpyLogger().spyLogger,
      spokePool_1,
      new MockHubPoolClient(null, null, null),
      null,
      destinationChainId
    ); // create spoke pool client on the "target" chain.
    // expect(spokePoolClientForDestinationChain.getDepositForFill(fill_1)).to.equal(undefined);
    await spokePoolClientForDestinationChain.update();

    // Override the fill's realized LP fee % and destination token so that it matches the deposit's default zero'd
    // out values. The destination token and realized LP fee % are set by the spoke pool client by querying the hub pool
    // contract state, however this test ignores the rate model contract and therefore there is no hub pool contract
    // to query from, so they will be set to 0x0 and 0% respectively.
    const expectedDeposit = {
      ...deposit_1,
      destinationToken: zeroAddress,
      realizedLpFeePct: toBN(0),
    };
    expect(
      spokePoolClientForDestinationChain.getDepositForFill({
        ...fill_1,
        destinationToken: zeroAddress,
        realizedLpFeePct: toBN(0),
      })
    ).to.deep.equal(expectedDeposit);
  });

  it("Returns sped up deposit matched with fill", async function () {
    const deposit_1 = {
      ...(await deposit(spokePool_1, erc20_1, depositor, depositor, destinationChainId)),
      originBlockNumber: await getLastBlockNumber(),
      blockNumber: 0,
    };
    // Override the fill's realized LP fee % and destination token so that it matches the deposit's default zero'd
    // out values. The destination token and realized LP fee % are set by the spoke pool client by querying the hub pool
    // contract state, however this test ignores the rate model contract and therefore there is no hub pool contract
    // to query from, so they will be set to 0x0 and 0% respectively.
    const expectedDeposit = {
      ...deposit_1,
      destinationToken: zeroAddress,
      realizedLpFeePct: toBN(0),
    };
    const fill_1 = await buildFill(spokePool_2, erc20_2, depositor, relayer, expectedDeposit, 0.2);
    const fill_2 = await buildModifiedFill(spokePool_2, depositor, relayer, fill_1, 2, 0.2); // Fill same % of deposit with 2x larger relayer fee pct.

    const spokePoolClientForDestinationChain = new SpokePoolClient(
      createSpyLogger().spyLogger,
      spokePool_1,
      new MockHubPoolClient(null, null, null),
      null,
      destinationChainId
    ); // create spoke pool client on the "target" chain.
    await spokePoolClientForDestinationChain.update();

    expect(fill_1.appliedRelayerFeePct.eq(fill_2.appliedRelayerFeePct)).to.be.false;
    expect(
      spokePoolClientForDestinationChain.getDepositForFill({
        ...fill_1,
        destinationToken: zeroAddress,
        realizedLpFeePct: toBN(0),
      })
    ).to.deep.equal(expectedDeposit);
    expect(
      spokePoolClientForDestinationChain.getDepositForFill({
        ...fill_2,
        destinationToken: zeroAddress,
        realizedLpFeePct: toBN(0),
      })
    ).to.deep.equal(expectedDeposit);
  });

  it("Rejects fills that dont match the deposit data", async function () {
    await deposit(spokePool_1, erc20_1, depositor, depositor, destinationChainId);
    await fillRelay(spokePool_2, erc20_2, depositor, depositor, relayer, 0, originChainId);

    await spokePoolClient2.update();
    await spokePoolClient1.update();

    const [incompleteDeposit] = spokePoolClient1.getDeposits();
    const [validFill] = spokePoolClient2.getFills();
    const validDeposit = {
      ...incompleteDeposit,
      realizedLpFeePct: validFill.realizedLpFeePct,
      destinationToken: validFill.destinationToken,
    };

    // Invalid Amount.
    expect(spokePoolClient2.validateFillForDeposit({ ...validFill, amount: toBNWei(1337) }, validDeposit)).to.be.false;

    // Invalid depositId.
    expect(spokePoolClient2.validateFillForDeposit({ ...validFill, depositId: 1337 }, validDeposit)).to.be.false;

    // Changed the depositor.
    expect(spokePoolClient2.validateFillForDeposit({ ...validFill, depositor: relayer.address }, validDeposit)).to.be
      .false;

    // Changed the recipient.
    expect(spokePoolClient2.validateFillForDeposit({ ...validFill, recipient: relayer.address }, validDeposit)).to.be
      .false;

    // Changed the relayerFeePct.
    expect(spokePoolClient2.validateFillForDeposit({ ...validFill, relayerFeePct: toBNWei(1337) }, validDeposit)).to.be
      .false;

    // Validate the realizedLPFeePct and destinationToken matches. These values are optional in the deposit object and
    // are assigned during the update method, which is not polled in this set of tests.

    // Assign a realizedLPFeePct to the deposit and check it matches with the fill. The default set on a fill (from
    // contracts-v2) is 0.1. After, try changing this to a separate value and ensure this is rejected.
    expect(spokePoolClient2.validateFillForDeposit(validFill, { ...validDeposit, realizedLpFeePct: toBNWei(0.1) })).to
      .be.true;

    expect(spokePoolClient2.validateFillForDeposit(validFill, { ...validDeposit, realizedLpFeePct: toBNWei(0.1337) }))
      .to.be.false;

    // Assign a destinationToken to the deposit and ensure it is validated correctly. erc20_2 from the fillRelay method
    // above is the destination token. After, try changing this to something that is clearly wrong.
    expect(spokePoolClient2.validateFillForDeposit(validFill, { ...validDeposit, destinationToken: erc20_2.address }))
      .to.be.true;
    expect(spokePoolClient2.validateFillForDeposit(validFill, { ...validDeposit, destinationToken: owner.address })).to
      .be.false;
  });
});
