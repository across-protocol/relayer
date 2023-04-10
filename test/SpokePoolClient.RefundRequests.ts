import { groupBy, random } from "lodash";
import { SpokePoolClient } from "../src/clients";
import { RefundRequest, RefundRequestWithBlock } from "../src/interfaces";
import {
  createSpyLogger,
  expect,
  ethers,
  Contract,
  SignerWithAddress,
  destinationChainId,
  originChainId,
  repaymentChainId,
  deploySpokePoolWithToken,
  toBN,
  toBNWei,
} from "./utils";

let spokePool: Contract, refundToken: Contract;
let relayer: SignerWithAddress;
let deploymentBlock: number;
let spokePoolClient: SpokePoolClient;
let requestTemplate: RefundRequest, requestBlockTemplate: RefundRequestWithBlock;

describe("SpokePoolClient: Refund Requests", async function () {
  beforeEach(async function () {
    [relayer] = await ethers.getSigners();
    ({
      spokePool,
      weth: refundToken,
      deploymentBlock,
    } = await deploySpokePoolWithToken(originChainId, destinationChainId));
    await spokePool.setChainId(repaymentChainId); // Refunds requests are submitted on the repayment chain.

    requestTemplate = {
      relayer: relayer.address,
      refundToken: refundToken.address,
      amount: toBN(1),
      originChainId,
      destinationChainId,
      realizedLpFeePct: toBNWei(".0001"),
      // depositId should be individually.
      fillBlock: toBN(random(1, 100_000)),
      previousIdenticalRequests: toBN(0),
    } as RefundRequest;

    spokePoolClient = new SpokePoolClient(
      createSpyLogger().spyLogger,
      spokePool,
      null,
      repaymentChainId,
      deploymentBlock
    );
    await spokePoolClient.update();

    const withBlockTemplate = {
      transactionIndex: 0,
      logIndex: random(1, 10),
      transactionHash: ethers.utils.id(`Across-v2-${random(1, 100_000)}`),
    };
    requestBlockTemplate = { ...requestTemplate, ...withBlockTemplate } as RefundRequestWithBlock;
  });

  it("Correctly fetches refund requests", async function () {
    const refundRequests: RefundRequestWithBlock[] = [];
    for (let _idx = 0; _idx < 5; ++_idx) {
      const blockNumber = random(deploymentBlock, spokePoolClient.latestBlockNumber as number);
      refundRequests.push({ ...requestBlockTemplate, depositId: random(1, 100), blockNumber });
      ++requestBlockTemplate.transactionIndex;
    }

    // @todo: SpokePool.requestRefund() does not exist yet. Temporarily force the request events in via the back door.
    // const refundRequest = await requestRefund(...);
    spokePoolClient.refundRequests = spokePoolClient.refundRequests.concat(refundRequests);
    await spokePoolClient.update();

    refundRequests.forEach((refundRequest, idx) => {
      const _refundRequests = spokePoolClient.getRefundRequests();
      expect(_refundRequests[idx]).to.deep.contains(refundRequest);
    });
  });

  it("Correctly filters out unwanted refund requests based on blockNumber", async function () {
    expect(spokePoolClient.latestBlockNumber).to.not.be.undefined; // type guard
    const latestBlockNumber = spokePoolClient.latestBlockNumber as number;
    expect(latestBlockNumber - deploymentBlock).to.be.at.least(3);

    const refundRequests: RefundRequestWithBlock[] = [];
    for (let blockNumber = deploymentBlock; blockNumber <= latestBlockNumber; ++blockNumber) {
      refundRequests.push({ ...requestBlockTemplate, depositId: random(1, 100), blockNumber });
    }

    // @todo: SpokePool.requestRefund() does not exist yet. Temporarily force the request events in via the back door.
    // const refundRequest = await requestRefund(...);
    spokePoolClient.refundRequests = spokePoolClient.refundRequests.concat(refundRequests);
    await spokePoolClient.update();

    const fromBlock = deploymentBlock + 1;
    const toBlock = latestBlockNumber - 1;
    const { filteredRequests = [], excludedRequests = [] } = groupBy(refundRequests, (refundRequest) => {
      return refundRequest.blockNumber > deploymentBlock && refundRequest.blockNumber < latestBlockNumber
        ? "filteredRequests"
        : "excludedRequests";
    });

    expect(spokePoolClient.getRefundRequests()).to.have.deep.members(refundRequests);
    expect(spokePoolClient.getRefundRequests(fromBlock, toBlock)).to.have.deep.members(filteredRequests);
    expect(spokePoolClient.getRefundRequests(fromBlock, toBlock)).to.not.have.deep.members(excludedRequests);
  });
});
