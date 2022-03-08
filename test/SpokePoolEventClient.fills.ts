import { expect, ethers, Contract, SignerWithAddress, originChainId } from "across-contracts";
import { spokePoolFixture, fillRelay, enableRoutes } from "across-contracts";

import { setupTokensForWallet } from "./SpokePoolEventClient.utils";
import { SpokePoolEventClient } from "../src/SpokePoolEventClient";

let spokePool: Contract, erc20: Contract, destErc20: Contract, weth: Contract;
let owner: SignerWithAddress, depositor: SignerWithAddress, relayer1: SignerWithAddress, relayer2: SignerWithAddress;
let destinationChainId: number;
const originChainId2 = originChainId + 1;

let spokePoolClient: SpokePoolEventClient;

describe.only("SpokePoolEventClient Fills", async function () {
  beforeEach(async function () {
    [owner, depositor, relayer1, relayer2] = await ethers.getSigners();
    ({ spokePool, erc20, destErc20, weth } = await spokePoolFixture());
    destinationChainId = (await ethers.provider.getNetwork()).chainId;

    await enableRoutes(spokePool, [
      { originToken: erc20.address, destinationChainId },
      { originToken: erc20.address, destinationChainId },
    ]);
    spokePoolClient = new SpokePoolEventClient(spokePool, destinationChainId, 0);
  });

  it("Correctly fetches fill data single fill, single chain", async function () {
    await setupTokensForWallet(spokePool, relayer1, [erc20, destErc20], weth, 10);
    const fill1 = await fillRelay(spokePool, erc20, depositor, depositor, relayer1, 0); // 0 deposit ID
    const fill2 = await fillRelay(spokePool, erc20, depositor, depositor, relayer1, 1); // 1 deposit ID

    await spokePoolClient.update();

    expect(spokePoolClient.getFillsForDestinationChain(destinationChainId)).to.deep.equal([fill1, fill2]);
  });
  it("Correctly fetches deposit data multiple fills, multiple chains", async function () {
    await setupTokensForWallet(spokePool, relayer1, [erc20, destErc20], weth, 10);
    await setupTokensForWallet(spokePool, relayer2, [erc20, destErc20], weth, 10);
    // Do 6 deposits. 2 for the first depositor on chain1, 1 for the first depositor on chain2, 1 for the second
    // depositor on chain1, and 2 for the second depositor on chain2.
    const relayer1Chain1_1 = await fillRelay(spokePool, erc20, depositor, depositor, relayer1, 0, originChainId);
    const relayer1Chain1_2 = await fillRelay(spokePool, erc20, depositor, depositor, relayer1, 0, originChainId);
    const relayer1Chain2_1 = await fillRelay(spokePool, erc20, depositor, depositor, relayer1, 0, originChainId2);

    const relayer2Chain1_1 = await fillRelay(spokePool, erc20, depositor, depositor, relayer2, 0, originChainId);
    const relayer2Chain2_1 = await fillRelay(spokePool, erc20, depositor, depositor, relayer2, 0, originChainId2);
    const relayer2Chain2_2 = await fillRelay(spokePool, erc20, depositor, depositor, relayer2, 0, originChainId2);

    await spokePoolClient.update();

    console.log(
      "spokePoolClient.getFillsForDestinationChain(originChainId)",
      spokePoolClient.getFillsForDestinationChain(destinationChainId)
    );

    // Validate associated ChainId Events are correctly returned.
    expect(spokePoolClient.getFillsForDestinationChain(destinationChainId)).to.deep.equal([
      relayer1Chain1_1,
      relayer1Chain1_2,
      relayer1Chain2_1,
      relayer2Chain1_1,
      relayer2Chain2_1,
      relayer2Chain2_2,
    ]);

    expect(spokePoolClient.getFillsForOriginChain(originChainId)).to.deep.equal([
      relayer1Chain1_1,
      relayer1Chain1_2,
      relayer2Chain1_1,
    ]);

    expect(spokePoolClient.getFillsForOriginChain(originChainId2)).to.deep.equal([
      relayer1Chain2_1,
      relayer2Chain2_1,
      relayer2Chain2_2,
    ]);

    expect(spokePoolClient.getFillsForRelayer(relayer1.address)).to.deep.equal([
      relayer1Chain1_1,
      relayer1Chain1_2,
      relayer1Chain2_1,
    ]);

    expect(spokePoolClient.getFillsForRelayer(relayer2.address)).to.deep.equal([
      relayer2Chain1_1,
      relayer2Chain2_1,
      relayer2Chain2_2,
    ]);
  });
});
