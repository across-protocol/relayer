import { expect, ethers, Contract } from "./utils";
import { SignerWithAddress, buildSlowRelayTree } from "./utils";
import { buildDeposit, buildFill, buildModifiedFill } from "./utils";
import { SpokePoolClient, HubPoolClient, RateModelClient } from "../src/clients";
import { amountToDeposit, repaymentChainId, destinationChainId, originChainId } from "./constants";
import { setupDataworker } from "./fixtures/Dataworker.Fixture";

import { Dataworker } from "../src/dataworker/Dataworker"; // Tested
import { toBN } from "../src/utils";

let spokePool_1: Contract, erc20_1: Contract, spokePool_2: Contract, erc20_2: Contract;
let l1Token_1: Contract, l1Token_2: Contract;
let depositor: SignerWithAddress, relayer: SignerWithAddress;

let spokePoolClient_1: SpokePoolClient, spokePoolClient_2: SpokePoolClient;
let rateModelClient: RateModelClient, hubPoolClient: HubPoolClient;
let dataworkerInstance: Dataworker;

let updateAllClients: () => Promise<void>;

describe("Dataworker: Load data used in all functions", async function () {
  beforeEach(async function () {
    ({
      spokePool_1,
      erc20_1,
      spokePool_2,
      erc20_2,
      rateModelClient,
      hubPoolClient,
      l1Token_1,
      l1Token_2,
      depositor,
      relayer,
      dataworkerInstance,
      spokePoolClient_1,
      spokePoolClient_2,
      updateAllClients,
    } = await setupDataworker(ethers, 25));
  });

  it("Default conditions", async function () {
    // Throws error if spoke pool client not updated.
    expect(() => dataworkerInstance._loadData()).to.throw(/not updated/);

    // Throws error if hub pool client not updated.
    await rateModelClient.update();
    await spokePoolClient_1.update();
    await spokePoolClient_2.update();
    expect(() => dataworkerInstance._loadData()).to.throw(/HubPoolClient not updated/);

    // Before any deposits, returns empty dictionaries.
    await updateAllClients();
    expect(dataworkerInstance._loadData()).to.deep.equal({
      unfilledDeposits: [],
      deposits: [],
      fillsToRefund: {},
    });
  });
  it("Returns unfilled deposits", async function () {
    await updateAllClients();

    const deposit1 = await buildDeposit(
      rateModelClient,
      hubPoolClient,
      spokePool_1,
      erc20_1,
      l1Token_1,
      depositor,
      destinationChainId,
      amountToDeposit
    );
    const deposit2 = await buildDeposit(
      rateModelClient,
      hubPoolClient,
      spokePool_2,
      erc20_2,
      l1Token_2,
      depositor,
      originChainId,
      amountToDeposit
    );

    // Unfilled deposits are ignored.
    await updateAllClients();
    const data1 = dataworkerInstance._loadData();
    expect(data1.unfilledDeposits).to.deep.equal([]);

    // Two deposits with no fills per destination chain ID.
    await buildDeposit(
      rateModelClient,
      hubPoolClient,
      spokePool_1,
      erc20_1,
      l1Token_1,
      depositor,
      destinationChainId,
      amountToDeposit.mul(toBN(2))
    );
    await buildDeposit(
      rateModelClient,
      hubPoolClient,
      spokePool_2,
      erc20_2,
      l1Token_2,
      depositor,
      originChainId,
      amountToDeposit.mul(toBN(2))
    );
    await updateAllClients();
    const data2 = dataworkerInstance._loadData();
    expect(data2.unfilledDeposits).to.deep.equal([]);

    // Fills that don't match deposits do not affect unfilledAmount counter.
    // Note: We switch the spoke pool address in the following fills from the fills that eventually do match with
    //       the deposits.
    await buildFill(spokePool_1, erc20_2, depositor, relayer, deposit1, 0.5);
    await buildFill(spokePool_2, erc20_1, depositor, relayer, deposit2, 0.25);

    // One partially filled deposit per destination chain ID.
    const fill1 = await buildFill(spokePool_2, erc20_2, depositor, relayer, deposit1, 0.5);
    const fill2 = await buildFill(spokePool_1, erc20_1, depositor, relayer, deposit2, 0.25);
    await updateAllClients();
    const data3 = dataworkerInstance._loadData();
    expect(data3.unfilledDeposits).to.deep.equal([
      { unfilledAmount: amountToDeposit.sub(fill1.fillAmount), deposit: deposit1 },
      { unfilledAmount: amountToDeposit.sub(fill2.fillAmount), deposit: deposit2 },
    ]);

    // All deposits are fulfilled; unfilled deposits that are fully filled should be ignored.
    await buildFill(spokePool_2, erc20_2, depositor, relayer, deposit1, 1);
    await buildFill(spokePool_1, erc20_1, depositor, relayer, deposit2, 1);
    await updateAllClients();
    const data5 = dataworkerInstance._loadData();
    expect(data5.unfilledDeposits).to.deep.equal([]);

    // TODO: Add test where deposit has matched fills but none were the first ever fill for that deposit (i.e. where
    // fill.amount != fill.totalAmountFilled). This can only be done after adding in block range constraints on Fill
    // events queried. Also test that fill amounts equal to zero don't count as first fills.

    // Fill events emitted by slow relays are included in unfilled amount calculations.
    const deposit5 = await buildDeposit(
      rateModelClient,
      hubPoolClient,
      spokePool_2,
      erc20_2,
      l1Token_1,
      depositor,
      originChainId,
      amountToDeposit
    );
    const fill3 = await buildFill(spokePool_1, erc20_1, depositor, relayer, deposit5, 0.25);

    // One unfilled deposit that we're going to slow fill:
    await updateAllClients();
    const data6 = dataworkerInstance._loadData();
    expect(data6.unfilledDeposits).to.deep.equal([
      { unfilledAmount: amountToDeposit.sub(fill3.fillAmount), deposit: deposit5 },
    ]);

    const slowRelays = [
      {
        depositor: fill3.depositor,
        recipient: fill3.recipient,
        destinationToken: fill3.destinationToken,
        amount: fill3.amount,
        originChainId: fill3.originChainId.toString(),
        destinationChainId: fill3.destinationChainId.toString(),
        realizedLpFeePct: fill3.realizedLpFeePct,
        relayerFeePct: fill3.relayerFeePct,
        depositId: fill3.depositId.toString(),
      },
    ];
    const tree = await buildSlowRelayTree(slowRelays);
    await spokePool_1.relayRootBundle(tree.getHexRoot(), tree.getHexRoot());
    await spokePool_1.connect(depositor).executeSlowRelayLeaf(
      fill3.depositor,
      fill3.recipient,
      fill3.destinationToken,
      fill3.amount.toString(),
      fill3.originChainId.toString(),
      fill3.realizedLpFeePct.toString(),
      fill3.relayerFeePct.toString(),
      fill3.depositId.toString(),
      "0",
      [] // Proof for tree with 1 leaf is empty
    );

    // The unfilled deposit has now been fully filled.
    await updateAllClients();
    const data7 = dataworkerInstance._loadData();
    expect(data7.unfilledDeposits).to.deep.equal([]);
  });
  it("Returns fills to refund", async function () {
    await updateAllClients();

    const deposit1 = await buildDeposit(
      rateModelClient,
      hubPoolClient,
      spokePool_1,
      erc20_1,
      l1Token_1,
      depositor,
      destinationChainId,
      amountToDeposit
    );
    const deposit2 = await buildDeposit(
      rateModelClient,
      hubPoolClient,
      spokePool_2,
      erc20_2,
      l1Token_2,
      depositor,
      originChainId,
      amountToDeposit
    );

    // Submit a valid fill.
    const fill1 = await buildFill(spokePool_2, erc20_2, depositor, relayer, deposit1, 0.5);
    await updateAllClients();
    const data1 = dataworkerInstance._loadData();
    expect(data1.fillsToRefund).to.deep.equal({
      [repaymentChainId]: { [erc20_2.address]: [fill1] },
    });

    // Submit a fill for another L2 token.
    const fill2 = await buildFill(spokePool_1, erc20_1, depositor, relayer, deposit2, 0.25);
    await updateAllClients();
    const data2 = dataworkerInstance._loadData();
    expect(data2.fillsToRefund).to.deep.equal({
      [repaymentChainId]: { [erc20_2.address]: [fill1], [erc20_1.address]: [fill2] },
    });

    // Submit fills without matching deposits. These should be ignored by the client.
    // Note: Switch just the relayer fee % to make fills invalid. This also ensures that client is correctly
    // distinguishing between valid speed up fills with modified relayer fee %'s and invalid fill relay calls
    // with all correct fill params except for the relayer fee %.
    await buildFill(spokePool_1, erc20_1, depositor, relayer, { ...deposit2, relayerFeePct: toBN(0) }, 0.5);
    await updateAllClients();
    const data3 = dataworkerInstance._loadData();
    expect(data3.fillsToRefund).to.deep.equal(data2.fillsToRefund);

    // Submit fills that match deposit in all properties except for realized lp fee % or l1 token. These should be
    // ignored because the rate model client deems them invalid. These are the two properties added to the deposit
    // object by the spoke pool client.
    // Note: This fill has identical deposit data to fill2 except for the realized lp fee %.
    await buildFill(
      spokePool_1,
      erc20_1,
      depositor,
      relayer,
      { ...deposit2, realizedLpFeePct: deposit2.realizedLpFeePct.div(toBN(2)) },
      0.25
    );
    // Note: This fill has identical deposit data to fill2 except for the destination token being different
    await buildFill(spokePool_1, erc20_2, depositor, relayer, deposit2, 0.25);
    await updateAllClients();
    const data4 = dataworkerInstance._loadData();
    expect(data4.fillsToRefund).to.deep.equal(data2.fillsToRefund);

    // Fill events emitted by slow relays should be ignored.
    const deposit3 = await buildDeposit(
      rateModelClient,
      hubPoolClient,
      spokePool_2,
      erc20_2,
      l1Token_2,
      depositor,
      originChainId,
      amountToDeposit
    );
    const fill3 = await buildFill(spokePool_1, erc20_1, depositor, relayer, deposit3, 0.25);
    const slowRelays = [
      {
        depositor: fill3.depositor,
        recipient: fill3.recipient,
        destinationToken: fill3.destinationToken,
        amount: fill3.amount,
        originChainId: fill3.originChainId.toString(),
        destinationChainId: fill3.destinationChainId.toString(),
        realizedLpFeePct: fill3.realizedLpFeePct,
        relayerFeePct: fill3.relayerFeePct,
        depositId: fill3.depositId.toString(),
      },
    ];
    const tree = await buildSlowRelayTree(slowRelays);
    await spokePool_1.relayRootBundle(tree.getHexRoot(), tree.getHexRoot());
    await spokePool_1.connect(depositor).executeSlowRelayLeaf(
      fill3.depositor,
      fill3.recipient,
      fill3.destinationToken,
      fill3.amount.toString(),
      fill3.originChainId.toString(),
      fill3.realizedLpFeePct.toString(),
      fill3.relayerFeePct.toString(),
      fill3.depositId.toString(),
      "0",
      [] // Proof for tree with 1 leaf is empty
    );
    await updateAllClients();
    const data5 = dataworkerInstance._loadData();
    // Note: If the dataworker does not explicitly filter out slow relays then the fillsToRefund object
    // will contain refunds associated with repaymentChainId 0.
    expect(data5.fillsToRefund).to.deep.equal({
      [repaymentChainId]: { [erc20_2.address]: [fill1], [erc20_1.address]: [fill2, fill3] },
    });

    // Speed up relays are included. Re-use the same fill information
    const fill4 = await buildModifiedFill(spokePool_1, depositor, relayer, fill2, 2, 0.1);
    expect(fill4.totalFilledAmount.gt(fill4.fillAmount), "speed up fill didn't match original deposit");
    await updateAllClients();
    const data6 = dataworkerInstance._loadData();
    expect(data6.fillsToRefund).to.deep.equal({
      [repaymentChainId]: { [erc20_2.address]: [fill1], [erc20_1.address]: [fill2, fill3, fill4] },
    });
  });
});
