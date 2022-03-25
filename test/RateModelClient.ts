import { deploySpokePoolWithToken, destinationChainId, originChainId } from "./utils";
import { assert, expect, ethers, Contract, SignerWithAddress, setupTokensForWallet, assertPromiseError, toBNWei } from "./utils";
import { getContractFactory, hubPoolFixture, toBN } from "./utils";
import { amountToLp, sampleRateModel } from "./constants";

import { HubPoolClient } from "../src/clients/HubPoolClient";
import { RateModelClient } from "../src/clients/RateModelClient";

let spokePool: Contract, hubPool: Contract, l2Token: Contract;
let rateModelStore: Contract, l1Token: Contract, timer: Contract
let owner: SignerWithAddress;

let rateModelClient: RateModelClient, hubPoolClient: HubPoolClient;

describe("RateModelClient", async function () {
    beforeEach(async function () {
        [owner] = await ethers.getSigners();
        ({ spokePool, erc20: l2Token } = await deploySpokePoolWithToken(originChainId, destinationChainId));
        ({ hubPool, timer, dai: l1Token } = await hubPoolFixture());
        await hubPool.enableL1TokenForLiquidityProvision(l1Token.address);

        rateModelStore = await (await getContractFactory("RateModelStore", owner)).deploy();
        hubPoolClient = new HubPoolClient(hubPool);
        rateModelClient = new RateModelClient(rateModelStore, hubPoolClient);

        await setupTokensForWallet(spokePool, owner, [l1Token], null, 100); // Seed owner to LP.
        await l1Token.approve(hubPool.address, amountToLp);
        await hubPool.addLiquidity(l1Token.address, amountToLp);
    });

    it("update", async function() {
        // Throws if HubPool isn't updated.
        assertPromiseError(rateModelClient.update(), "hubpool not updated");
        await hubPoolClient.update();

        // If RateModelStore has no events, stores nothing.
        await rateModelClient.update();
        expect(rateModelClient.cumulativeRateModelEvents.length).to.equal(0);

        // Add new RateModelEvents and check that updating again pulls in new events.
        await rateModelStore.updateRateModel(l1Token.address, JSON.stringify(sampleRateModel));
        await rateModelClient.update();
        expect(rateModelClient.cumulativeRateModelEvents.length).to.equal(1);
    })

    describe("RateModelStore contract has 1 initial update", function() {
        beforeEach(async function() {
            await rateModelStore.updateRateModel(l1Token.address, JSON.stringify(sampleRateModel));
            await updateAllClients();
        })
    
        it("getRateModelForBlockNumber", async function() {
            const initialRateModelUpdate = (await rateModelStore.queryFilter(
                rateModelStore.filters.UpdatedRateModel()
            ))[0];
    
            expect(rateModelClient.getRateModelForBlockNumber(l1Token.address, initialRateModelUpdate.blockNumber)).to.deep.equal(sampleRateModel)
    
            // Block number when there is no rate model
            try {
                rateModelClient.getRateModelForBlockNumber(l1Token.address, initialRateModelUpdate.blockNumber - 1);
                assert(false);
              } catch (err) {
                assert.isTrue(err.message.includes("before first UpdatedRateModel event"));
              }
    
            // L1 token where there is no rate model
            try {
                rateModelClient.getRateModelForBlockNumber(l2Token.address, initialRateModelUpdate.blockNumber);
                assert(false);
              } catch (err) {
                assert.isTrue(err.message.includes("No updated rate model"));
              }
        })
    
        it("computeRealizedLpFeePct", async function() {
            const initialRateModelUpdate = (await rateModelStore.queryFilter(
                rateModelStore.filters.UpdatedRateModel()
            ))[0];
            const initialRateModelUpdateTime = (await ethers.provider.getBlock(initialRateModelUpdate.blockNumber)).timestamp    

            // Takes into account deposit amount's effect on utilization. This deposit uses 10% of the pool's liquidity
            // so the fee should reflect a 10% post deposit utilization.
            const depositData = {
                depositId: 0,
                depositor: owner.address,
                recipient: owner.address,
                originToken: l2Token.address,
                destinationToken: l1Token.address,
                realizedLpFeePct: toBN(0),
                amount: amountToLp.div(10),
                originChainId,
                destinationChainId,
                relayerFeePct: toBN(0),
                quoteTimestamp: initialRateModelUpdateTime,
                // Quote time needs to be >= first rate model event time
              };
            await rateModelClient.update();

            // TODO: Validate that this rate is expected
            expect(
              await rateModelClient.computeRealizedLpFeePct(depositData, l1Token.address)
            ).to.equal(toBNWei("0.000835322155994299"));

            // Higher deposit should result in higher LP fee
            expect(
                await rateModelClient.computeRealizedLpFeePct({ ...depositData,  amount: depositData.amount.mul(2) }, l1Token.address)
              ).to.equal(toBNWei("0.000915784051288600"));
      
            // TODO: Test modifying the current liquidity utilization by executing a pool rebalance
            // // Let's increase the pool utilization from 0% to 10% by sending 10% of the pool's liquidity to
            // // another chain.
            // const leaves = buildPoolRebalanceLeaves(
            //         [destinationChainId],
            //         [[l1Token]], // l1Token. We will only be sending 1 token to one chain.
            //         [[0]], // bundleLpFees.
            //         [[amountToLp.div(10)]], // netSendAmounts.
            //         [[0]], // runningBalances.
            //         [0] // groupIndex
            //     );
            //     const tree = await buildPoolRebalanceLeafTree(leaves);
            // await hubPool.proposeRootBundle([1], 1, tree.getHexRoot(), createRandomBytes32(), createRandomBytes32);
            // await timer.setCurrentTime(Number(await timer.getCurrentTime()) + refundProposalLiveness + 1);
            // await hubPool.executeRootBundle(...Object.values(leaves[0]), tree.getHexProof(leaves[0]));

        })
    
    })

});

async function updateAllClients() {
  // Note: Must update upstream clients first, for example hubPool before rateModel store
  await hubPoolClient.update();
  await rateModelClient.update();
}
