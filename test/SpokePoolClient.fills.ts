import { SpokePoolClient } from "../src/clients";
import { Deposit } from "../src/interfaces";
import {
  Contract,
  SignerWithAddress,
  buildFill,
  createSpyLogger,
  deploySpokePoolWithToken,
  destinationChainId,
  ethers,
  expect,
  originChainId,
  setupTokensForWallet,
  toBNWei,
} from "./utils";

let spokePool: Contract, erc20: Contract, destErc20: Contract, weth: Contract;
let depositor: SignerWithAddress, relayer1: SignerWithAddress, relayer2: SignerWithAddress;
let deploymentBlock: number;

const originChainId2 = originChainId + 1;

let spokePoolClient: SpokePoolClient;

describe("SpokePoolClient: Fills", async function () {
  beforeEach(async function () {
    [, depositor, relayer1, relayer2] = await ethers.getSigners();
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
    const deposit: Deposit = {
      depositId: 0,
      depositor: depositor.address,
      recipient: depositor.address,
      originToken: erc20.address,
      amount: toBNWei("1"),
      originChainId,
      destinationChainId,
      relayerFeePct: toBNWei("0.01"),
      quoteTimestamp: Date.now(),
      realizedLpFeePct: toBNWei("0.01"),
      destinationToken: destErc20.address,
      message: "0x",
    };
    await buildFill(spokePool, destErc20, depositor, relayer1, deposit, 1);
    await buildFill(spokePool, destErc20, depositor, relayer1, { ...deposit, depositId: 1 }, 1);
    await spokePoolClient.update();
    expect(spokePoolClient.getFills().length).to.equal(2);
  });
  it("Correctly fetches deposit data multiple fills, multiple chains", async function () {
    const deposit: Deposit = {
      depositId: 0,
      depositor: depositor.address,
      recipient: depositor.address,
      originToken: erc20.address,
      amount: toBNWei("1"),
      originChainId,
      destinationChainId,
      relayerFeePct: toBNWei("0.01"),
      quoteTimestamp: Date.now(),
      realizedLpFeePct: toBNWei("0.01"),
      destinationToken: destErc20.address,
      message: "0x",
    };

    // Do 6 deposits. 2 for the first depositor on chain1, 1 for the first depositor on chain2, 1 for the second
    // depositor on chain1, and 2 for the second depositor on chain2.
    await buildFill(spokePool, destErc20, depositor, relayer1, deposit, 0.1);
    await buildFill(spokePool, destErc20, depositor, relayer1, deposit, 0.1);
    await buildFill(spokePool, destErc20, depositor, relayer1, { ...deposit, originChainId: originChainId2 }, 0.1);

    await buildFill(spokePool, destErc20, depositor, relayer2, deposit, 0.1);
    await buildFill(spokePool, destErc20, depositor, relayer2, { ...deposit, originChainId: originChainId2 }, 0.1);
    await buildFill(spokePool, destErc20, depositor, relayer2, { ...deposit, originChainId: originChainId2 }, 0.1);

    await spokePoolClient.update();

    // Validate associated ChainId Events are correctly returned.
    expect(spokePoolClient.getFills().length).to.equal(6);

    // TODO: Add `getFillsForRepaymentChainId` tests once we update the `fillRelay` method from contracts-v2 to allow
    // an overridable `repaymentChainId`

    expect(spokePoolClient.getFillsForOriginChain(originChainId).length).to.equal(3);
    expect(spokePoolClient.getFillsForOriginChain(originChainId2).length).to.equal(3);
    expect(spokePoolClient.getFillsForRelayer(relayer1.address).length).to.equal(3);
    expect(spokePoolClient.getFillsForRelayer(relayer2.address).length).to.equal(3);
  });
});
