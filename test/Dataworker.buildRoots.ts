import { deploySpokePoolWithToken, enableRoutesOnHubPool, expect, ethers, Contract, buildSlowRelayTree, RelayData } from "./utils";
import { SignerWithAddress, setupTokensForWallet, getLastBlockTime } from "./utils";
import { buildDeposit, buildFill } from "./utils";
import { createSpyLogger, winston, deployAndConfigureHubPool, deployRateModelStore } from "./utils";
import { SpokePoolClient, HubPoolClient, RateModelClient, MultiCallBundler } from "../src/clients";
import { amountToLp, amountToDeposit, repaymentChainId, destinationChainId, originChainId } from "./constants";

import { Dataworker } from "../src/dataworker/Dataworker"; // Tested
import { toBN } from "../src/utils";
import { Deposit } from "@uma/contracts-node/dist/packages/contracts-node/typechain/core/web3/Bridge";

let spokePool_1: Contract, erc20_1: Contract, spokePool_2: Contract, erc20_2: Contract;
let hubPool: Contract, rateModelStore: Contract, l1Token: Contract;
let owner: SignerWithAddress, depositor: SignerWithAddress, relayer: SignerWithAddress;
let spyLogger: winston.Logger;

let spokePoolClient_1: SpokePoolClient, spokePoolClient_2: SpokePoolClient;
let rateModelClient: RateModelClient, hubPoolClient: HubPoolClient;
let dataworkerInstance: Dataworker;
let multiCallBundler: MultiCallBundler;

describe("Dataworker: Build merkle roots", async function () {
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
    // Before any deposits, returns null.
    await updateAllClients();
    expect(await dataworkerInstance.buildSlowRelayRoot([])).to.equal(null);
  });
  it("Build slow relay root", async function () {
    await updateAllClients();

    // Submit deposits for multiple destination chain IDs.
    const deposit1 = await buildDeposit(
        rateModelClient,
        hubPoolClient,
        spokePool_1,
        erc20_1,
        l1Token,
        depositor,
        destinationChainId,
        amountToDeposit
      )
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

    // Slow relays should be sorted by destination chain ID and amount. We don't sort on unfilled amount since
    // there are no fills yet.
    const expectedRelaysUnsorted: RelayData[] = [deposit1, deposit2, deposit3, deposit4]
      .map((_deposit) => {
        return {
            depositor: _deposit.depositor,
            recipient: _deposit.recipient,
            destinationToken: _deposit.depositor,
            amount: _deposit.amount.toString(),
            originChainId: _deposit.originChainId.toString(),
            destinationChainId: _deposit.destinationChainId.toString(),
            realizedLpFeePct: _deposit.realizedLpFeePct.toString(),
            relayerFeePct: _deposit.relayerFeePct.toString(),
            depositId: _deposit.depositId.toString(),
        }
      })


      

    // Returns expected merkle root where leaves are ordered by destination chain ID and then unfilled amount 
    // (descending).
    await updateAllClients();
    const merkleRoot1 = await dataworkerInstance.buildSlowRelayRoot([]);
    const expectedMerkleRoot1 = await buildSlowRelayTree([
      expectedRelaysUnsorted[2],
      expectedRelaysUnsorted[0],
      expectedRelaysUnsorted[3],
      expectedRelaysUnsorted[1],
    ]);
    expect(merkleRoot1.getHexRoot()).to.equal(expectedMerkleRoot1.getHexRoot());

    // Partially fill two deposits such that the order of the deposits switches based on unfilled amounts.
    await buildFill(spokePool_2, erc20_2, depositor, relayer, deposit3, 0.9);
    await buildFill(spokePool_1, erc20_1, depositor, relayer, deposit4, 0.9);
    await updateAllClients();
    const merkleRoot2 = await dataworkerInstance.buildSlowRelayRoot([]);
    const expectedMerkleRoot2 = await buildSlowRelayTree([
      expectedRelaysUnsorted[0],
      expectedRelaysUnsorted[2],
      expectedRelaysUnsorted[1],
      expectedRelaysUnsorted[3],
    ]); // Note how deposits for the same destination chain ID are flipped.
    expect(merkleRoot2.getHexRoot()).to.equal(expectedMerkleRoot2.getHexRoot());

    // Fill deposits such that there are no unfilled deposits remaining.
    await buildFill(spokePool_2, erc20_2, depositor, relayer, deposit1, 1);
    await buildFill(spokePool_1, erc20_1, depositor, relayer, deposit2, 1);
    await buildFill(spokePool_2, erc20_2, depositor, relayer, deposit3, 1);
    await buildFill(spokePool_1, erc20_1, depositor, relayer, deposit4, 1);
    await updateAllClients();
    expect(await dataworkerInstance.buildSlowRelayRoot([])).to.equal(null);
  });
});

async function updateAllClients() {
  await hubPoolClient.update();
  await rateModelClient.update();
  await spokePoolClient_1.update();
  await spokePoolClient_2.update();
}
