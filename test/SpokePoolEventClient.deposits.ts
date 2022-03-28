import { expect, ethers, Contract, SignerWithAddress, setupTokensForWallet } from "./utils";
import { deploySpokePoolWithToken, enableRoutes, simpleDeposit, originChainId, destinationChainId } from "./utils";

import { SpokePoolClient } from "../src/clients/SpokePoolClient";

let spokePool: Contract, erc20: Contract, destErc20: Contract, weth: Contract;
let owner: SignerWithAddress, depositor1: SignerWithAddress, depositor2: SignerWithAddress;
const destinationChainId2 = destinationChainId + 1;

let spokePoolClient: SpokePoolClient;

describe("SpokePoolClient: Deposits", async function () {
  beforeEach(async function () {
    [owner, depositor1, depositor2] = await ethers.getSigners();
    ({ spokePool, erc20, destErc20, weth } = await deploySpokePoolWithToken(originChainId));
    await enableRoutes(spokePool, [{ originToken: erc20.address, destinationChainId: destinationChainId2 }]);
    spokePoolClient = new SpokePoolClient(spokePool, null, originChainId);

    await setupTokensForWallet(spokePool, depositor1, [erc20, destErc20], weth, 10);
    await setupTokensForWallet(spokePool, depositor2, [erc20, destErc20], weth, 10);
  });

  it("Correctly fetches deposit data single depositor, single chain", async function () {
    const deposit1 = await simpleDeposit(spokePool, erc20, depositor1, depositor1, destinationChainId);
    const deposit2 = await simpleDeposit(spokePool, erc20, depositor1, depositor1, destinationChainId);

    await spokePoolClient.update();

    expect(spokePoolClient.getDepositsForDestinationChain(destinationChainId)).to.deep.equal([deposit1, deposit2]);
  });
  it("Correctly fetches deposit data multiple depositors, multiple chains", async function () {
    // Do 6 deposits. 2 for the first depositor on chain1, 1 for the first depositor on chain2, 1 for the second
    // depositor on chain1, and 2 for the second depositor on chain2. For each deposit append the data that is excluded
    // from the deposit as it cant be fetched from the contract directly (realizedLpFeePct, destinationToken).
    const deposit1Chain1_1 = await simpleDeposit(spokePool, erc20, depositor1, depositor1, destinationChainId);
    const deposit1Chain1_2 = await simpleDeposit(spokePool, erc20, depositor1, depositor1, destinationChainId);
    const deposit1Chain2_1 = await simpleDeposit(spokePool, erc20, depositor1, depositor1, destinationChainId2);
    const deposit2Chain1_1 = await simpleDeposit(spokePool, erc20, depositor2, depositor2, destinationChainId);
    const deposit2Chain2_1 = await simpleDeposit(spokePool, erc20, depositor2, depositor2, destinationChainId2);
    const deposit2Chain2_2 = await simpleDeposit(spokePool, erc20, depositor2, depositor2, destinationChainId2);
    await spokePoolClient.update();

    // Validate associated ChainId Events are correctly returned.
    expect(spokePoolClient.getDepositsForDestinationChain(destinationChainId)).to.deep.equal([
      deposit1Chain1_1,
      deposit1Chain1_2,
      deposit2Chain1_1,
    ]);

    expect(spokePoolClient.getDepositsForDestinationChain(destinationChainId2)).to.deep.equal([
      deposit1Chain2_1,
      deposit2Chain2_1,
      deposit2Chain2_2,
    ]);

    // Validate associated depositor address information is correctly returned.
    expect(spokePoolClient.getDepositsFromDepositor(depositor1.address)).to.deep.equal([
      deposit1Chain1_1,
      deposit1Chain1_2,
      deposit1Chain2_1,
    ]);

    expect(spokePoolClient.getDepositsFromDepositor(depositor2.address)).to.deep.equal([
      deposit2Chain1_1,
      deposit2Chain2_1,
      deposit2Chain2_2,
    ]);
  });
});
