import { expect, deposit, ethers, Contract, SignerWithAddress, setupTokensForWallet, winston, sinon } from "./utils";
import { deployAndEnableSpokePool, enableRoutes, destinationChainId, originChainId, createSpyLogger } from "./utils";

import { SpokePoolEventClient } from "../src/SpokePoolEventClient";
import { Relayer } from "../src/Relayer";

let spokePool_1: Contract, erc20_1: Contract, spokePool_2: Contract, erc20_2: Contract;
let owner: SignerWithAddress, depositor1: SignerWithAddress, depositor2: SignerWithAddress, relayer1: SignerWithAddress;

let spy: sinon.SinonSpy, spyLogger: winston.Logger;
let spokePoolClient_1: SpokePoolEventClient, spokePoolClient_2: SpokePoolEventClient;
let relayer: Relayer;

describe.only("Relayer Unfilled Deposits", async function () {
  beforeEach(async function () {
    [owner, depositor1, depositor2, relayer1] = await ethers.getSigners();
    // Deploy the two spokePools and their associated tokens. Set the chainId to match to associated chainIds. The first
    // prop is the chainId set on the spoke pool. The second prop is the chain ID enabled in the route on the spokePool.
    ({ spokePool: spokePool_1, erc20: erc20_1 } = await deployAndEnableSpokePool(originChainId, destinationChainId));
    console.log("spokePool_1", await spokePool_1.chainId());
    ({ spokePool: spokePool_2, erc20: erc20_2 } = await deployAndEnableSpokePool(destinationChainId, originChainId));
    console.log("spokePool_2", await spokePool_2.chainId());

    spokePoolClient_1 = new SpokePoolEventClient(spokePool_1, originChainId);
    spokePoolClient_2 = new SpokePoolEventClient(spokePool_2, destinationChainId);

    ({ spy, spyLogger } = createSpyLogger());

    relayer = new Relayer(
      spyLogger,
      { [originChainId]: spokePoolClient_1, [destinationChainId]: spokePoolClient_2 },
      0 // MulticallBundler. Update later once this is implemented.
    );
  });

  it("Correctly fetches unfilled deposits", async function () {
    await setupTokensForWallet(spokePool_1, depositor1, [erc20_1], null, 10);
    await setupTokensForWallet(spokePool_2, depositor2, [erc20_2], null, 10);

    const deposit1 = await deposit(spokePool_1, erc20_1, depositor1, depositor1, destinationChainId);
    console.log("deposit1", deposit1);
    const deposit2 = await deposit(spokePool_2, erc20_2, depositor2, depositor2, originChainId);
    console.log("deposit2", deposit2);

    await Promise.all([spokePoolClient_1.update(), spokePoolClient_2.update()]);

    const unfilledDeposits = relayer.getUnfilledDeposits();
    console.log("unfilledDeposits", unfilledDeposits);

    expect(unfilledDeposits).to.deep.equal([
      { unfilledAmount: deposit1.amount, deposit: deposit1 },
      { unfilledAmount: deposit2.amount, deposit: deposit2 },
    ]);
  });
});
