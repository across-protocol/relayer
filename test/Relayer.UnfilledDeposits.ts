import { deploySpokePoolWithToken, fillRelay, destinationChainId, originChainId, createSpyLogger } from "./utils";
import { expect, deposit, ethers, Contract, SignerWithAddress, setupTokensForWallet, winston, sinon } from "./utils";

import { SpokePoolEventClient } from "../src/SpokePoolEventClient";
import { Relayer } from "../src/Relayer";

let spokePool_1: Contract, erc20_1: Contract, spokePool_2: Contract, erc20_2: Contract;
let depositor_1: SignerWithAddress, depositor_2: SignerWithAddress, relayer_1: SignerWithAddress;

let spy: sinon.SinonSpy, spyLogger: winston.Logger;
let spokePoolClient_1: SpokePoolEventClient, spokePoolClient_2: SpokePoolEventClient;
let relayer: Relayer;

describe("Relayer: Unfilled Deposits", async function () {
  beforeEach(async function () {
    [depositor_1, depositor_2, relayer_1] = await ethers.getSigners();
    // Deploy the two spokePools and their associated tokens. Set the chainId to match to associated chainIds. The first
    // prop is the chainId set on the spoke pool. The second prop is the chain ID enabled in the route on the spokePool.
    ({ spokePool: spokePool_1, erc20: erc20_1 } = await deploySpokePoolWithToken(originChainId, destinationChainId));
    ({ spokePool: spokePool_2, erc20: erc20_2 } = await deploySpokePoolWithToken(destinationChainId, originChainId));

    spokePoolClient_1 = new SpokePoolEventClient(spokePool_1, originChainId);
    spokePoolClient_2 = new SpokePoolEventClient(spokePool_2, destinationChainId);

    ({ spy, spyLogger } = createSpyLogger());

    relayer = new Relayer(
      spyLogger,
      { [originChainId]: spokePoolClient_1, [destinationChainId]: spokePoolClient_2 },
      null, // HubPoolClient not needed for this set of tests.
      null // MulticallBundler. Update later once this is implemented.
    );

    await setupTokensForWallet(spokePool_1, depositor_1, [erc20_1], null, 10);
    await setupTokensForWallet(spokePool_2, depositor_2, [erc20_2], null, 10);
    await setupTokensForWallet(spokePool_1, relayer_1, [erc20_1], null, 10);
    await setupTokensForWallet(spokePool_2, relayer_1, [erc20_2], null, 10);
  });

  it("Correctly fetches unfilled deposits", async function () {
    const deposit1 = await deposit(spokePool_1, erc20_1, depositor_1, depositor_1, destinationChainId);
    const deposit2 = await deposit(spokePool_2, erc20_2, depositor_2, depositor_2, originChainId);

    await Promise.all([spokePoolClient_1.update(), spokePoolClient_2.update()]);

    expect(relayer.getUnfilledDeposits()).to.deep.equal([
      { unfilledAmount: deposit1.amount, deposit: deposit1 },
      { unfilledAmount: deposit2.amount, deposit: deposit2 },
    ]);
  });
  it("Correctly fetches partially filled deposits", async function () {
    const deposit1 = await deposit(spokePool_1, erc20_1, depositor_1, depositor_1, destinationChainId);
    const deposit2 = await deposit(spokePool_2, erc20_2, depositor_2, depositor_2, originChainId);

    // Partially fill the first deposit, which is sent to the second spoke pool, with one fill.
    const fillProps = [spokePool_2, erc20_2, depositor_1, depositor_1, relayer_1, 0] as const;
    const fill1 = await fillRelay(...fillProps);

    await Promise.all([spokePoolClient_1.update(), spokePoolClient_2.update()]);

    expect(relayer.getUnfilledDeposits()).to.deep.equal([
      { unfilledAmount: deposit1.amount.sub(fill1.fillAmount), deposit: deposit1 },
      { unfilledAmount: deposit2.amount, deposit: deposit2 },
    ]);

    // Partially fill the same deposit another two times.
    const fill2 = await fillRelay(...fillProps);
    const fill3 = await fillRelay(...fillProps);

    await Promise.all([spokePoolClient_1.update(), spokePoolClient_2.update()]);

    const expectedUnfilledAmount = deposit1.amount.sub(fill1.fillAmount.add(fill2.fillAmount).add(fill3.fillAmount));
    expect(relayer.getUnfilledDeposits()).to.deep.equal([
      { unfilledAmount: expectedUnfilledAmount, deposit: deposit1 },
      { unfilledAmount: deposit2.amount, deposit: deposit2 },
    ]);

    // Fill the reminding amount on the deposit. It should thus be removed from the unfilledDeposits list.
    const fill4 = await fillRelay(...fillProps, originChainId, deposit1.amount, expectedUnfilledAmount);
    expect(fill4.totalFilledAmount).to.equal(deposit1.amount); // should be 100% filled at this point.
    await Promise.all([spokePoolClient_1.update(), spokePoolClient_2.update()]);
    expect(relayer.getUnfilledDeposits()).to.deep.equal([{ unfilledAmount: deposit2.amount, deposit: deposit2 }]);
  });
  it("Correctly excludes fills that are incorrectly applied to a deposit", async function () {
    const deposit1 = await deposit(spokePool_1, erc20_1, depositor_1, depositor_1, destinationChainId);

    // Partially fill the deposit, incorrectly by setting the wrong deposit ID.
    const fill1 = await fillRelay(spokePool_2, erc20_2, depositor_1, depositor_1, relayer_1, 1);

    await Promise.all([spokePoolClient_1.update(), spokePoolClient_2.update()]);

    // The deposit should show up as unfilled, since the fill was incorrectly applied to the wrong deposit.
    expect(relayer.getUnfilledDeposits()).to.deep.equal([{ unfilledAmount: deposit1.amount, deposit: deposit1 }]);
  });
});
