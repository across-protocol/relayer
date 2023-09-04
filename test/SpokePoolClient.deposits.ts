import { SpokePoolClient } from "../src/clients";
import {
  Contract,
  SignerWithAddress,
  createSpyLogger,
  deploySpokePoolWithToken,
  destinationChainId,
  enableRoutes,
  ethers,
  expect,
  originChainId,
  setupTokensForWallet,
  simpleDeposit,
} from "./utils";

let spokePool: Contract, erc20: Contract, destErc20: Contract, weth: Contract;
let depositor1: SignerWithAddress, depositor2: SignerWithAddress;
let deploymentBlock: number;
const destinationChainId2 = destinationChainId + 1;

let spokePoolClient: SpokePoolClient;

describe("SpokePoolClient: Deposits", async function () {
  beforeEach(async function () {
    [, depositor1, depositor2] = await ethers.getSigners();
    ({ spokePool, erc20, destErc20, weth, deploymentBlock } = await deploySpokePoolWithToken(originChainId));
    await enableRoutes(spokePool, [{ originToken: erc20.address, destinationChainId: destinationChainId2 }]);
    spokePoolClient = new SpokePoolClient(createSpyLogger().spyLogger, spokePool, null, originChainId, deploymentBlock);

    await setupTokensForWallet(spokePool, depositor1, [erc20, destErc20], weth, 10);
    await setupTokensForWallet(spokePool, depositor2, [erc20, destErc20], weth, 10);
  });

  it("Correctly fetches deposit data single depositor, single chain", async function () {
    const inputDeposits = [
      await simpleDeposit(spokePool, erc20, depositor1, depositor1, destinationChainId),
      await simpleDeposit(spokePool, erc20, depositor1, depositor1, destinationChainId),
    ];
    await spokePoolClient.update();

    const outputDeposits = spokePoolClient.getDepositsForDestinationChain(destinationChainId);
    expect(outputDeposits.length).to.equal(2);
    inputDeposits.forEach((deposit, idx) => {
      expect(outputDeposits[idx].blockTimestamp).to.not.be.undefined;
      expect(outputDeposits[idx].realizedLpFeePct).to.not.be.undefined;
      Object.entries(deposit).forEach(([k, v]) => expect(v).to.be.equal(outputDeposits[idx][k]));
    });
  });
  it("Correctly fetches deposit data from multiple chains", async function () {
    // Do 6 deposits. 2 for the first depositor on chain1, 1 for the first depositor on chain2,
    // 1 for the second depositor on chain1, and 2 for the second depositor on chain2.
    const inputDeposits = [
      await simpleDeposit(spokePool, erc20, depositor1, depositor1, destinationChainId),
      await simpleDeposit(spokePool, erc20, depositor1, depositor1, destinationChainId),
      await simpleDeposit(spokePool, erc20, depositor1, depositor1, destinationChainId2),
      await simpleDeposit(spokePool, erc20, depositor2, depositor2, destinationChainId),
      await simpleDeposit(spokePool, erc20, depositor2, depositor2, destinationChainId2),
      await simpleDeposit(spokePool, erc20, depositor2, depositor2, destinationChainId2),
    ];
    await spokePoolClient.update();

    const outputDeposits = Object.fromEntries(
      [destinationChainId, destinationChainId2].map((_destinationChainId) => {
        const destinationChainId = Number(_destinationChainId);
        const deposits = spokePoolClient.getDepositsForDestinationChain(destinationChainId);
        expect(deposits.length).to.equal(3);
        return [destinationChainId, deposits];
      })
    );

    // Validate associated ChainId Events are correctly returned.
    expect(Object.values(outputDeposits).flat().length).to.equal(Object.keys(inputDeposits).length);
    inputDeposits.forEach((inputDeposit) => {
      const depositId = inputDeposit.depositId as number;
      const destinationChainId = inputDeposit.destinationChainId as number;
      const outputDeposit = outputDeposits[destinationChainId].find((deposit) => deposit.depositId === depositId);
      Object.entries(inputDeposit).forEach(([k, v]) => {
        expect(v).to.not.be.undefined;
        expect(v).to.deep.equal(outputDeposit?.[k]);
      });
    });
  });
});
