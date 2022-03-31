import { deploySpokePoolWithToken, enableRoutesOnHubPool, destinationChainId, originChainId, sinon } from "./utils";
import {
  expect,
  deposit,
  ethers,
  Contract,
  SignerWithAddress,
  setupTokensForWallet,
  getLastBlockTime,
  fillRelay,
} from "./utils";
import { createSpyLogger, winston, deployAndConfigureHubPool, deployRateModelStore, BigNumber } from "./utils";
import { SpokePoolClient, HubPoolClient, RateModelClient, MultiCallBundler } from "../src/clients";
import { amountToLp, amountToDeposit, repaymentChainId } from "./constants";
import { Deposit, Fill } from "../src/interfaces/SpokePool";

import { Dataworker } from "../src/dataworker/Dataworker"; // Tested
import { toBN, toBNWei } from "../src/utils";

let spokePool_1: Contract, erc20_1: Contract, spokePool_2: Contract, erc20_2: Contract;
let hubPool: Contract, rateModelStore: Contract, l1Token: Contract;
let owner: SignerWithAddress, depositor: SignerWithAddress, relayer: SignerWithAddress;
let spyLogger: winston.Logger;

let spokePoolClient_1: SpokePoolClient, spokePoolClient_2: SpokePoolClient;
let rateModelClient: RateModelClient, hubPoolClient: HubPoolClient;
let dataworkerInstance: Dataworker;
let multiCallBundler: MultiCallBundler;

async function buildDeposit(
  spokePool: Contract,
  tokenToDeposit: Contract,
  recipient: SignerWithAddress,
  depositor: SignerWithAddress,
  _destinationChainId: number,
  _amountToDeposit: BigNumber = amountToDeposit
): Promise<Deposit> {
  const _deposit = await deposit(
    spokePool,
    tokenToDeposit,
    recipient,
    depositor,
    _destinationChainId,
    _amountToDeposit
  );
  return {
    ..._deposit,
    destinationToken: hubPoolClient.getDestinationTokenForDeposit(_deposit),
    realizedLpFeePct: await rateModelClient.computeRealizedLpFeePct(_deposit, l1Token.address),
  };
}

async function buildFill(
  spokePool: Contract,
  destinationToken: Contract,
  recipient: SignerWithAddress,
  depositor: SignerWithAddress,
  relayer: SignerWithAddress,
  deposit: Deposit,
  pctOfDepositToFill: number
): Promise<Fill> {
  return await fillRelay(
    spokePool,
    destinationToken,
    recipient,
    depositor,
    relayer,
    deposit.depositId,
    deposit.originChainId,
    deposit.amount,
    deposit.amount.mul(toBNWei(pctOfDepositToFill)).div(toBNWei(1)),
    deposit.realizedLpFeePct,
    deposit.relayerFeePct
  );
}

describe("Dataworker: Load data used in all functions", async function () {
  beforeEach(async function () {
    [owner, depositor, relayer] = await ethers.getSigners();
    ({ spokePool: spokePool_1, erc20: erc20_1 } = await deploySpokePoolWithToken(originChainId, destinationChainId));
    ({ spokePool: spokePool_2, erc20: erc20_2 } = await deploySpokePoolWithToken(destinationChainId, originChainId));

    // Only set cross chain contracts for one spoke pool to begin with.
    ({ hubPool, l1Token } = await deployAndConfigureHubPool(owner, [
      { l2ChainId: destinationChainId, spokePool: spokePool_2 },
    ]));

    // For each chain, enable routes to both erc20's so that we can fill relays
    await enableRoutesOnHubPool(hubPool, [
      { destinationChainId: originChainId, l1Token, destinationToken: erc20_1 },
      { destinationChainId: destinationChainId, l1Token, destinationToken: erc20_2 },
    ]);

    ({ spyLogger } = createSpyLogger());
    ({ rateModelStore } = await deployRateModelStore(owner, [l1Token]));
    hubPoolClient = new HubPoolClient(spyLogger, hubPool);
    rateModelClient = new RateModelClient(spyLogger, rateModelStore, hubPoolClient);

    multiCallBundler = new MultiCallBundler(spyLogger, null); // leave out the gasEstimator for now.

    spokePoolClient_1 = new SpokePoolClient(spyLogger, spokePool_1.connect(relayer), rateModelClient, originChainId);
    spokePoolClient_2 = new SpokePoolClient(
      spyLogger,
      spokePool_2.connect(relayer),
      rateModelClient,
      destinationChainId
    );

    dataworkerInstance = new Dataworker(
      spyLogger,
      { [originChainId]: spokePoolClient_1, [destinationChainId]: spokePoolClient_2 },
      hubPoolClient,
      multiCallBundler
    );

    // Give owner tokens to LP on HubPool with.
    await setupTokensForWallet(spokePool_1, owner, [l1Token], null, 100); // Seed owner to LP.
    await l1Token.approve(hubPool.address, amountToLp);
    await hubPool.addLiquidity(l1Token.address, amountToLp);

    // Give depositors the tokens they'll deposit into spoke pools:
    await setupTokensForWallet(spokePool_1, depositor, [erc20_1], null, 10);
    await setupTokensForWallet(spokePool_2, depositor, [erc20_2], null, 10);

    // Give relayers the tokens they'll need to relay on spoke pools:
    await setupTokensForWallet(spokePool_1, relayer, [erc20_1, erc20_2, l1Token], null, 10);
    await setupTokensForWallet(spokePool_2, relayer, [erc20_1, erc20_2, l1Token], null, 10);

    // Set the spokePool's time to the provider time. This is done to enable the block utility time finder identify a
    // "reasonable" block number based off the block time when looking at quote timestamps.
    await spokePool_1.setCurrentTime(await getLastBlockTime(spokePool_1.provider));
    await spokePool_2.setCurrentTime(await getLastBlockTime(spokePool_2.provider));
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
      spokePool_1,
      erc20_1,
      depositor,
      depositor,
      destinationChainId,
      amountToDeposit
    );
    const deposit2 = await buildDeposit(spokePool_2, erc20_2, depositor, depositor, originChainId, amountToDeposit);

    // One completely unfilled deposit per destination chain ID.
    await updateAllClients();
    const data1 = dataworkerInstance._loadData();
    expect(data1.unfilledDeposits).to.deep.equal({
      [destinationChainId]: [{ unfilledAmount: amountToDeposit, deposit: deposit1 }],
      [originChainId]: [{ unfilledAmount: amountToDeposit, deposit: deposit2 }],
    });

    // Two unfilled deposits per destination chain ID.
    const deposit3 = await buildDeposit(
      spokePool_1,
      erc20_1,
      depositor,
      depositor,
      destinationChainId,
      amountToDeposit.mul(toBN(2))
    );
    const deposit4 = await buildDeposit(
      spokePool_2,
      erc20_2,
      depositor,
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
    await buildFill(spokePool_1, erc20_2, depositor, depositor, relayer, deposit1, 0.5);
    await buildFill(spokePool_2, erc20_1, depositor, depositor, relayer, deposit2, 0.25);

    // Two unfilled deposits (one partially filled) per destination chain ID.
    const fill1 = await buildFill(spokePool_2, erc20_2, depositor, depositor, relayer, deposit1, 0.5);
    const fill2 = await buildFill(spokePool_1, erc20_1, depositor, depositor, relayer, deposit2, 0.25);
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
    await buildFill(spokePool_2, erc20_2, depositor, depositor, relayer, deposit3, 1);
    await buildFill(spokePool_1, erc20_1, depositor, depositor, relayer, deposit4, 1);
    await updateAllClients();
    const data4 = dataworkerInstance._loadData();
    expect(data4.unfilledDeposits).to.deep.equal({
      [destinationChainId]: [{ unfilledAmount: amountToDeposit.sub(fill1.fillAmount), deposit: deposit1 }],
      [originChainId]: [{ unfilledAmount: amountToDeposit.sub(fill2.fillAmount), deposit: deposit2 }],
    });

    // All deposits are fulfilled
    await buildFill(spokePool_2, erc20_2, depositor, depositor, relayer, deposit1, 1);
    await buildFill(spokePool_1, erc20_1, depositor, depositor, relayer, deposit2, 1);
    await updateAllClients();
    const data5 = dataworkerInstance._loadData();
    expect(data5.unfilledDeposits).to.deep.equal({});
  });
  it("Returns fills to refund", async function () {
    await updateAllClients();

    // Submit a valid fill
    const deposit1 = await buildDeposit(
      spokePool_1,
      erc20_1,
      depositor,
      depositor,
      destinationChainId,
      amountToDeposit
    );
    const deposit2 = await buildDeposit(spokePool_2, erc20_2, depositor, depositor, originChainId, amountToDeposit);
    const fill1 = await buildFill(spokePool_2, erc20_2, depositor, depositor, relayer, deposit1, 0.5);

    // Should return one valid fill linked to the repayment chain ID
    await updateAllClients();
    const data1 = dataworkerInstance._loadData();
    expect(data1.fillsToRefund).to.deep.equal({
      [repaymentChainId]: { [relayer.address]: [fill1] },
    });

    // Submit two more fills: one for the same relayer and one for a different one.
    const fill2 = await buildFill(spokePool_1, erc20_1, depositor, depositor, relayer, deposit2, 0.25);
    const fill3 = await buildFill(spokePool_2, erc20_2, depositor, depositor, depositor, deposit1, 1);
    await updateAllClients();
    const data2 = dataworkerInstance._loadData();
    expect(data2.fillsToRefund).to.deep.equal({
      [repaymentChainId]: { [relayer.address]: [fill1, fill2], [depositor.address]: [fill3] },
    });

    // Submit fills without matching deposits. These should be ignored by the client.
    // Note: Switch the deposit data to make fills invalid.
    await buildFill(spokePool_2, erc20_2, depositor, depositor, relayer, deposit2, 0.5);
    await buildFill(spokePool_2, erc20_2, depositor, depositor, depositor, deposit2, 1);
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
      depositor,
      relayer,
      { ...deposit2, realizedLpFeePct: deposit2.realizedLpFeePct.div(toBN(2)) },
      0.25
    );
    // Note: This fill has identical deposit data to fill2 except for the destination token being different
    await buildFill(spokePool_1, l1Token, depositor, depositor, relayer, deposit2, 0.25);
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
