import { expect, ethers, Contract } from "./utils";
import { SignerWithAddress } from "./utils";
import { buildDeposit, buildFill } from "./utils";
import { SpokePoolClient, HubPoolClient, RateModelClient } from "../src/clients";
import { amountToDeposit, repaymentChainId, destinationChainId, originChainId } from "./constants";
import { setupDataworker } from "./fixtures/Dataworker.Fixture"

import { Dataworker } from "../src/dataworker/Dataworker"; // Tested
import { toBN } from "../src/utils";

let spokePool_1: Contract, erc20_1: Contract, spokePool_2: Contract, erc20_2: Contract;
let l1Token: Contract;
let depositor: SignerWithAddress, relayer: SignerWithAddress;

let spokePoolClient_1: SpokePoolClient, spokePoolClient_2: SpokePoolClient;
let rateModelClient: RateModelClient, hubPoolClient: HubPoolClient;
let dataworkerInstance: Dataworker;

describe("Dataworker: Load data used in all functions", async function () {
  beforeEach(async function () {
    ({
      spokePool_1,
      erc20_1,
      spokePool_2,
      erc20_2,
      rateModelClient,
      hubPoolClient,
      l1Token,
      depositor,
      relayer,
      dataworkerInstance,
      spokePoolClient_1,
      spokePoolClient_2,
    } = await setupDataworker(ethers));
  });

  it("Default conditions", async function () {
    // Throws error if spoke pool client not updated.
    expect(() => dataworkerInstance._loadData()).to.throw(/not updated/);

    // Before any deposits, returns empty dictionaries.
    await updateAllClients();
    expect(dataworkerInstance._loadData()).to.deep.equal({
      unfilledDeposits: {},
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
      l1Token,
      depositor,
      destinationChainId,
      amountToDeposit
    );
    const deposit2 = await buildDeposit(
      rateModelClient,
      hubPoolClient,
      spokePool_2,
      erc20_2,
      l1Token,
      depositor,
      originChainId,
      amountToDeposit
    );

    // One completely unfilled deposit per destination chain ID.
    await updateAllClients();
    const data1 = dataworkerInstance._loadData();
    expect(data1.unfilledDeposits).to.deep.equal({
      [destinationChainId]: [{ unfilledAmount: amountToDeposit, deposit: deposit1 }],
      [originChainId]: [{ unfilledAmount: amountToDeposit, deposit: deposit2 }],
    });

    // Two unfilled deposits per destination chain ID.
    const deposit3 = await buildDeposit(
      rateModelClient,
      hubPoolClient,
      spokePool_1,
      erc20_1,
      l1Token,
      depositor,
      destinationChainId,
      amountToDeposit.mul(toBN(2))
    );
    const deposit4 = await buildDeposit(
      rateModelClient,
      hubPoolClient,
      spokePool_2,
      erc20_2,
      l1Token,
      depositor,
      originChainId,
      amountToDeposit.mul(toBN(2))
    );
    await updateAllClients();
    const data2 = dataworkerInstance._loadData();
    expect(data2.unfilledDeposits).to.deep.equal({
      [destinationChainId]: [
        { unfilledAmount: amountToDeposit, deposit: deposit1 },
        { unfilledAmount: amountToDeposit.mul(toBN(2)), deposit: deposit3 },
      ],
      [originChainId]: [
        { unfilledAmount: amountToDeposit, deposit: deposit2 },
        { unfilledAmount: amountToDeposit.mul(toBN(2)), deposit: deposit4 },
      ],
    });

    // Fills that don't match deposits do not affect unfilledAmount counter.
    // Note: We switch the spoke pool address in the following fills from the fills that eventually do match with
    //       the deposits.
    await buildFill(spokePool_1, erc20_2, depositor, relayer, deposit1, 0.5);
    await buildFill(spokePool_2, erc20_1, depositor, relayer, deposit2, 0.25);

    // Two unfilled deposits (one partially filled) per destination chain ID.
    const fill1 = await buildFill(spokePool_2, erc20_2, depositor, relayer, deposit1, 0.5);
    const fill2 = await buildFill(spokePool_1, erc20_1, depositor, relayer, deposit2, 0.25);
    await updateAllClients();
    const data3 = dataworkerInstance._loadData();
    expect(data3.unfilledDeposits).to.deep.equal({
      [destinationChainId]: [
        { unfilledAmount: amountToDeposit.sub(fill1.fillAmount), deposit: deposit1 },
        { unfilledAmount: amountToDeposit.mul(toBN(2)), deposit: deposit3 },
      ],
      [originChainId]: [
        { unfilledAmount: amountToDeposit.sub(fill2.fillAmount), deposit: deposit2 },
        { unfilledAmount: amountToDeposit.mul(toBN(2)), deposit: deposit4 },
      ],
    });

    // One completely filled deposit per destination chain ID.
    await buildFill(spokePool_2, erc20_2, depositor, relayer, deposit3, 1);
    await buildFill(spokePool_1, erc20_1, depositor, relayer, deposit4, 1);
    await updateAllClients();
    const data4 = dataworkerInstance._loadData();
    expect(data4.unfilledDeposits).to.deep.equal({
      [destinationChainId]: [{ unfilledAmount: amountToDeposit.sub(fill1.fillAmount), deposit: deposit1 }],
      [originChainId]: [{ unfilledAmount: amountToDeposit.sub(fill2.fillAmount), deposit: deposit2 }],
    });

    // All deposits are fulfilled
    await buildFill(spokePool_2, erc20_2, depositor, relayer, deposit1, 1);
    await buildFill(spokePool_1, erc20_1, depositor, relayer, deposit2, 1);
    await updateAllClients();
    const data5 = dataworkerInstance._loadData();
    expect(data5.unfilledDeposits).to.deep.equal({});
  });
  it("Returns fills to refund", async function () {
    await updateAllClients();

    // Submit a valid fill
    const deposit1 = await buildDeposit(
      rateModelClient,
      hubPoolClient,
      spokePool_1,
      erc20_1,
      l1Token,
      depositor,
      destinationChainId,
      amountToDeposit
    );
    const deposit2 = await buildDeposit(
      rateModelClient,
      hubPoolClient,
      spokePool_2,
      erc20_2,
      l1Token,
      depositor,
      originChainId,
      amountToDeposit
    );
    const fill1 = await buildFill(spokePool_2, erc20_2, depositor, relayer, deposit1, 0.5);

    // Should return one valid fill linked to the repayment chain ID
    await updateAllClients();
    const data1 = dataworkerInstance._loadData();
    expect(data1.fillsToRefund).to.deep.equal({
      [repaymentChainId]: { [relayer.address]: [fill1] },
    });

    // Submit two more fills: one for the same relayer and one for a different one.
    const fill2 = await buildFill(spokePool_1, erc20_1, depositor, relayer, deposit2, 0.25);
    const fill3 = await buildFill(spokePool_2, erc20_2, depositor, depositor, deposit1, 1);
    await updateAllClients();
    const data2 = dataworkerInstance._loadData();
    expect(data2.fillsToRefund).to.deep.equal({
      [repaymentChainId]: { [relayer.address]: [fill1, fill2], [depositor.address]: [fill3] },
    });

    // Submit fills without matching deposits. These should be ignored by the client.
    // Note: Switch the deposit data to make fills invalid.
    await buildFill(spokePool_2, erc20_2, depositor, relayer, deposit2, 0.5);
    await buildFill(spokePool_2, erc20_2, depositor, depositor, deposit2, 1);
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
    await buildFill(spokePool_1, l1Token, depositor, relayer, deposit2, 0.25);
    await updateAllClients();
    const data4 = dataworkerInstance._loadData();
    expect(data4.fillsToRefund).to.deep.equal(data2.fillsToRefund);
  });
});

async function updateAllClients() {
  await hubPoolClient.update();
  await rateModelClient.update();
  await spokePoolClient_1.update();
  await spokePoolClient_2.update();
}
