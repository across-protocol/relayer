import {
  expect,
  ethers,
  Contract,
  buildSlowRelayTree,
  RelayData,
  buildFillForRepaymentChain,
  buildRelayerRefundTree,
  toBN,
  toBNWei,
} from "./utils";
import { SignerWithAddress } from "./utils";
import { buildDeposit, buildFill } from "./utils";
import { SpokePoolClient, HubPoolClient, RateModelClient } from "../src/clients";
import { amountToDeposit, destinationChainId, originChainId } from "./constants";
import { setupDataworker } from "./fixtures/Dataworker.Fixture";

import { Dataworker } from "../src/dataworker/Dataworker"; // Tested
import { RelayerRefundLeaf } from "../src/utils";
import { Deposit } from "../src/interfaces/SpokePool";

let spokePool_1: Contract, erc20_1: Contract, spokePool_2: Contract, erc20_2: Contract;
let l1Token_1: Contract;
let depositor: SignerWithAddress, relayer: SignerWithAddress;

let spokePoolClient_1: SpokePoolClient, spokePoolClient_2: SpokePoolClient;
let rateModelClient: RateModelClient, hubPoolClient: HubPoolClient;
let dataworkerInstance: Dataworker;

describe("Dataworker: Build merkle roots", async function () {
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
    } = await setupDataworker(ethers));
  });
  it("Default conditions", async function () {
    // When given empty input data, returns null.
    await updateAllClients();
    expect(await dataworkerInstance.buildSlowRelayRoot([])).to.equal(null);
    expect(await dataworkerInstance.buildRelayerRefundRoot([])).to.equal(null);
  });
  it("Build slow relay root", async function () {
    await updateAllClients();

    // Submit deposits for multiple destination chain IDs.
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
      l1Token_1,
      depositor,
      originChainId,
      amountToDeposit
    );
    const deposit3 = await buildDeposit(
      rateModelClient,
      hubPoolClient,
      spokePool_1,
      erc20_1,
      l1Token_1,
      depositor,
      destinationChainId,
      amountToDeposit
    );
    const deposit4 = await buildDeposit(
      rateModelClient,
      hubPoolClient,
      spokePool_2,
      erc20_2,
      l1Token_1,
      depositor,
      originChainId,
      amountToDeposit
    );

    // Slow relays should be sorted by origin chain ID and deposit ID.
    const expectedRelaysUnsorted: RelayData[] = [deposit1, deposit2, deposit3, deposit4].map((_deposit) => {
      return {
        depositor: _deposit.depositor,
        recipient: _deposit.recipient,
        destinationToken: _deposit.depositor,
        amount: _deposit.amount,
        originChainId: _deposit.originChainId.toString(),
        destinationChainId: _deposit.destinationChainId.toString(),
        realizedLpFeePct: _deposit.realizedLpFeePct,
        relayerFeePct: _deposit.relayerFeePct,
        depositId: _deposit.depositId.toString(),
      };
    });

    // Add fills for each deposit so dataworker includes deposits as slow relays:
    await buildFill(spokePool_2, erc20_2, depositor, relayer, deposit1, 0.1);
    await buildFill(spokePool_1, erc20_1, depositor, relayer, deposit2, 0.1);
    await buildFill(spokePool_2, erc20_2, depositor, relayer, deposit3, 0.1);
    await buildFill(spokePool_1, erc20_1, depositor, relayer, deposit4, 0.1);

    // Returns expected merkle root where leaves are ordered by origin chain ID and then deposit ID
    // (ascending).
    await updateAllClients();
    const merkleRoot1 = await dataworkerInstance.buildSlowRelayRoot([]);
    const expectedMerkleRoot1 = await buildSlowRelayTree([
      expectedRelaysUnsorted[0],
      expectedRelaysUnsorted[2],
      expectedRelaysUnsorted[1],
      expectedRelaysUnsorted[3],
    ]);
    expect(merkleRoot1.getHexRoot()).to.equal(expectedMerkleRoot1.getHexRoot());

    // Fill deposits such that there are no unfilled deposits remaining.
    await buildFill(spokePool_2, erc20_2, depositor, relayer, deposit1, 1);
    await buildFill(spokePool_1, erc20_1, depositor, relayer, deposit2, 1);
    await buildFill(spokePool_2, erc20_2, depositor, relayer, deposit3, 1);
    await buildFill(spokePool_1, erc20_1, depositor, relayer, deposit4, 1);
    await updateAllClients();
    expect(await dataworkerInstance.buildSlowRelayRoot([])).to.equal(null);
  });
  it("Build relayer refund root", async function () {
    await updateAllClients();

    // Submit deposits for multiple L2 tokens.
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
      l1Token_1,
      depositor,
      originChainId,
      amountToDeposit
    );
    const deposit3 = await buildDeposit(
      rateModelClient,
      hubPoolClient,
      spokePool_1,
      erc20_1,
      l1Token_1,
      depositor,
      destinationChainId,
      amountToDeposit
    );
    const deposit4 = await buildDeposit(
      rateModelClient,
      hubPoolClient,
      spokePool_2,
      erc20_2,
      l1Token_1,
      depositor,
      originChainId,
      amountToDeposit.mul(2)
    );
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
    const deposit6 = await buildDeposit(
      rateModelClient,
      hubPoolClient,
      spokePool_1,
      erc20_1,
      l1Token_1,
      depositor,
      destinationChainId,
      amountToDeposit
    );

    // Submit fills for two relayers on one repayment chain and one destination token. Note: we know that
    // depositor address is alphabetically lower than relayer address, so submit fill from depositor first and test
    // that data worker sorts on refund address.
    await buildFillForRepaymentChain(spokePool_2, depositor, deposit3, 0.25, 100);
    await buildFillForRepaymentChain(spokePool_2, depositor, deposit3, 1, 100);
    await buildFillForRepaymentChain(spokePool_2, relayer, deposit1, 0.25, 100);
    await buildFillForRepaymentChain(spokePool_2, relayer, deposit1, 1, 100);

    const expectedRefundAmount = (deposit: Deposit) =>
      deposit.amount.mul(toBNWei(1).sub(deposit.realizedLpFeePct)).div(toBNWei(1));
    const buildTree = async (leaves) => {
      return await buildRelayerRefundTree(
        leaves.map((leaf, id) => {
          return { ...leaf, leafId: toBN(id) };
        })
      );
    };
    const leaf1 = {
      chainId: toBN(100),
      amountToReturn: toBN(0),
      l2TokenAddress: erc20_2.address,
      refundAddresses: [relayer.address, depositor.address], // Sorted ascending alphabetically
      refundAmounts: [expectedRefundAmount(deposit1), expectedRefundAmount(deposit3)], // Refund amounts should aggregate across all fills.
    };

    await updateAllClients();
    const merkleRoot1 = await dataworkerInstance.buildRelayerRefundRoot([]);
    const expectedMerkleRoot1 = await buildTree([leaf1]);
    expect(merkleRoot1.getHexRoot()).to.equal(expectedMerkleRoot1.getHexRoot());

    // Submit fills for a second destination token on on the same repayment chain.
    await buildFillForRepaymentChain(spokePool_1, relayer, deposit2, 1, 100);
    await buildFillForRepaymentChain(spokePool_1, depositor, deposit4, 1, 100);
    const leaf2 = {
      chainId: toBN(100),
      amountToReturn: toBN(0),
      l2TokenAddress: erc20_1.address,
      refundAddresses: [depositor.address, relayer.address], // Reversed order because deposit4 refund amount is larger.
      refundAmounts: [expectedRefundAmount(deposit4), expectedRefundAmount(deposit2)],
    };
    await updateAllClients();
    const merkleRoot2 = await dataworkerInstance.buildRelayerRefundRoot([]);
    const expectedMerkleRoot2 = await buildTree([leaf1, leaf2]);
    expect(merkleRoot2.getHexRoot()).to.equal(expectedMerkleRoot2.getHexRoot());

    // Submit fills for multiple repayment chains. Note: Send the fills for destination tokens in the
    // reverse order of the fills we sent above to test that the data worker is correctly sorting leaves
    // by L2 token address in ascending order. Also set repayment chain ID lower than first few leaves to test
    // that these leaves come first.
    await buildFillForRepaymentChain(spokePool_1, relayer, deposit5, 1, 99);
    await buildFillForRepaymentChain(spokePool_2, relayer, deposit6, 1, 99);
    const leaf3 = {
      chainId: toBN(99),
      amountToReturn: toBN(0),
      l2TokenAddress: erc20_2.address,
      refundAddresses: [relayer.address],
      refundAmounts: [expectedRefundAmount(deposit5)],
    };
    const leaf4 = {
      chainId: toBN(99),
      amountToReturn: toBN(0),
      l2TokenAddress: erc20_1.address,
      refundAddresses: [relayer.address],
      refundAmounts: [expectedRefundAmount(deposit6)],
    };
    await updateAllClients();
    const merkleRoot3 = await dataworkerInstance.buildRelayerRefundRoot([]);
    const expectedMerkleRoot3 = await buildTree([leaf3, leaf4, leaf1, leaf2]);
    expect(merkleRoot3.getHexRoot()).to.equal(expectedMerkleRoot3.getHexRoot());
  });
});

async function updateAllClients() {
  await hubPoolClient.update();
  await rateModelClient.update();
  await spokePoolClient_1.update();
  await spokePoolClient_2.update();
}
