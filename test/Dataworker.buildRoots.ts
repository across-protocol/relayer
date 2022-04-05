import { expect, ethers, Contract, buildSlowRelayTree, RelayData } from "./utils";
import { SignerWithAddress } from "./utils";
import { buildDeposit, buildFill } from "./utils";
import { SpokePoolClient, HubPoolClient, RateModelClient } from "../src/clients";
import { amountToDeposit, destinationChainId, originChainId } from "./constants";
import { setupDataworker } from "./fixtures/Dataworker.Fixture";

import { Dataworker } from "../src/dataworker/Dataworker"; // Tested

let spokePool_1: Contract, erc20_1: Contract, spokePool_2: Contract, erc20_2: Contract;
let l1Token: Contract;
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
      l1Token,
      depositor,
      relayer,
      dataworkerInstance,
      spokePoolClient_1,
      spokePoolClient_2,
    } = await setupDataworker(ethers));
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
    const deposit3 = await buildDeposit(
      rateModelClient,
      hubPoolClient,
      spokePool_1,
      erc20_1,
      l1Token,
      depositor,
      destinationChainId,
      amountToDeposit
    );
    const deposit4 = await buildDeposit(
      rateModelClient,
      hubPoolClient,
      spokePool_2,
      erc20_2,
      l1Token,
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
        amount: _deposit.amount.toString(),
        originChainId: _deposit.originChainId.toString(),
        destinationChainId: _deposit.destinationChainId.toString(),
        realizedLpFeePct: _deposit.realizedLpFeePct.toString(),
        relayerFeePct: _deposit.relayerFeePct.toString(),
        depositId: _deposit.depositId.toString(),
      };
    });

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
});

async function updateAllClients() {
  await hubPoolClient.update();
  await rateModelClient.update();
  await spokePoolClient_1.update();
  await spokePoolClient_2.update();
}
