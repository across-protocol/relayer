import { setupTokensForWallet, expect, ethers, Contract, SignerWithAddress, sinon, winston } from "./utils";
import { originChainId, deploySpokePoolWithToken, fillRelay, destinationChainId, createSpyLogger } from "./utils";
import { SpokePoolClient } from "../src/clients";

let spokePool: Contract, erc20: Contract, destErc20: Contract, weth: Contract;
let owner: SignerWithAddress, depositor: SignerWithAddress, relayer1: SignerWithAddress, relayer2: SignerWithAddress;
let deploymentBlock: number;

const originChainId2 = originChainId + 1;

let spokePoolClient: SpokePoolClient;

describe("SpokePoolClient: Fills", async function () {
  beforeEach(async function () {
    [owner, depositor, relayer1, relayer2] = await ethers.getSigners();
    ({ spokePool, erc20, destErc20, weth, deploymentBlock } = await deploySpokePoolWithToken(
      originChainId,
      destinationChainId
    ));
    await spokePool.setChainId(destinationChainId); // The spoke pool for a fill should be at the destinationChainId.

    spokePoolClient = new SpokePoolClient(
      createSpyLogger().spyLogger,
      spokePool,
      null,
      destinationChainId,
      deploymentBlock
    );

    await setupTokensForWallet(spokePool, relayer1, [erc20, destErc20], weth, 10);
    await setupTokensForWallet(spokePool, relayer2, [erc20, destErc20], weth, 10);
  });

  it("Correctly fetches fill data single fill, single chain", async function () {
    const fill1 = await fillRelay(spokePool, erc20, depositor, depositor, relayer1, 0); // 0 deposit ID
    const fill2 = await fillRelay(spokePool, erc20, depositor, depositor, relayer1, 1); // 1 deposit ID

    await spokePoolClient.update();

    expect(spokePoolClient.getFills()[0]).to.deep.contains(fill1);
    expect(spokePoolClient.getFills()[1]).to.deep.contains(fill2);
    expect(spokePoolClient.getFills().length).to.equal(2);
  });
  it("Correctly fetches deposit data multiple fills, multiple chains", async function () {
    // Do 6 deposits. 2 for the first depositor on chain1, 1 for the first depositor on chain2, 1 for the second
    // depositor on chain1, and 2 for the second depositor on chain2.
    const relayer1Chain1_1 = await fillRelay(spokePool, erc20, depositor, depositor, relayer1, 0, originChainId);
    const relayer1Chain1_2 = await fillRelay(spokePool, erc20, depositor, depositor, relayer1, 0, originChainId);
    const relayer1Chain2_1 = await fillRelay(spokePool, erc20, depositor, depositor, relayer1, 0, originChainId2);

    const relayer2Chain1_1 = await fillRelay(spokePool, erc20, depositor, depositor, relayer2, 0, originChainId);
    const relayer2Chain2_1 = await fillRelay(spokePool, erc20, depositor, depositor, relayer2, 0, originChainId2);
    const relayer2Chain2_2 = await fillRelay(spokePool, erc20, depositor, depositor, relayer2, 0, originChainId2);

    await spokePoolClient.update();

    // Validate associated ChainId Events are correctly returned.
    expect(spokePoolClient.getFills()[0]).to.deep.contains(relayer1Chain1_1);
    expect(spokePoolClient.getFills()[1]).to.deep.contains(relayer1Chain1_2);
    expect(spokePoolClient.getFills()[2]).to.deep.contains(relayer1Chain2_1);
    expect(spokePoolClient.getFills()[3]).to.deep.contains(relayer2Chain1_1);
    expect(spokePoolClient.getFills()[4]).to.deep.contains(relayer2Chain2_1);
    expect(spokePoolClient.getFills()[5]).to.deep.contains(relayer2Chain2_2);
    expect(spokePoolClient.getFills().length).to.equal(6);

    // TODO: Add `getFillsForRepaymentChainId` tests once we update the `fillRelay` method from contracts-v2 to allow
    // an overridable `repaymentChainId`

    expect(spokePoolClient.getFillsForOriginChain(originChainId)[0]).to.deep.contains(relayer1Chain1_1);
    expect(spokePoolClient.getFillsForOriginChain(originChainId)[1]).to.deep.contains(relayer1Chain1_2);
    expect(spokePoolClient.getFillsForOriginChain(originChainId)[2]).to.deep.contains(relayer2Chain1_1);
    expect(spokePoolClient.getFillsForOriginChain(originChainId).length).to.equal(3);

    expect(spokePoolClient.getFillsForOriginChain(originChainId2)[0]).to.deep.contains(relayer1Chain2_1);
    expect(spokePoolClient.getFillsForOriginChain(originChainId2)[1]).to.deep.contains(relayer2Chain2_1);
    expect(spokePoolClient.getFillsForOriginChain(originChainId2)[2]).to.deep.contains(relayer2Chain2_2);
    expect(spokePoolClient.getFillsForOriginChain(originChainId2).length).to.equal(3);

    expect(spokePoolClient.getFillsForRelayer(relayer1.address)[0]).to.deep.contains(relayer1Chain1_1);
    expect(spokePoolClient.getFillsForRelayer(relayer1.address)[1]).to.deep.contains(relayer1Chain1_2);
    expect(spokePoolClient.getFillsForRelayer(relayer1.address)[2]).to.deep.contains(relayer1Chain2_1);
    expect(spokePoolClient.getFillsForRelayer(relayer1.address).length).to.equal(3);

    expect(spokePoolClient.getFillsForRelayer(relayer2.address)[0]).to.deep.contains(relayer2Chain1_1);
    expect(spokePoolClient.getFillsForRelayer(relayer2.address)[1]).to.deep.contains(relayer2Chain2_1);
    expect(spokePoolClient.getFillsForRelayer(relayer2.address)[2]).to.deep.contains(relayer2Chain2_2);
    expect(spokePoolClient.getFillsForRelayer(relayer2.address).length).to.equal(3);
  });
});
