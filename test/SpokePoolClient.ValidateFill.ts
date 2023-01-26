import {
  expect,
  toBNWei,
  ethers,
  fillRelay,
  SignerWithAddress,
  deposit,
  setupTokensForWallet,
  toBN,
  buildFill,
  buildModifiedFill,
  deploySpokePoolWithToken,
  Contract,
  originChainId,
  destinationChainId,
  createSpyLogger,
  zeroAddress,
  getLastBlockNumber,
  deployAndConfigureHubPool,
  enableRoutesOnHubPool,
  deployConfigStore,
  getLastBlockTime,
  buildDeposit,
  hre,
  assertPromiseError,
  getDepositParams,
  mineRandomBlocks,
} from "./utils";

import { AcrossConfigStoreClient, HubPoolClient, SpokePoolClient } from "../src/clients";

let spokePool_1: Contract, erc20_1: Contract, spokePool_2: Contract, erc20_2: Contract, hubPool: Contract;
let owner: SignerWithAddress, depositor: SignerWithAddress, relayer: SignerWithAddress;
let spokePool1DeploymentBlock: number, spokePool2DeploymentBlock: number;
let l1Token: Contract, configStore: Contract;

let spokePoolClient2: SpokePoolClient, hubPoolClient: HubPoolClient;
let spokePoolClient1: SpokePoolClient, configStoreClient: AcrossConfigStoreClient;

describe("SpokePoolClient: Fill Validation", async function () {
  beforeEach(async function () {
    [owner, depositor, relayer] = await ethers.getSigners();
    // Creat two spoke pools: one to act as the source and the other to act as the destination.
    ({
      spokePool: spokePool_1,
      erc20: erc20_1,
      deploymentBlock: spokePool1DeploymentBlock,
    } = await deploySpokePoolWithToken(originChainId, destinationChainId));
    ({
      spokePool: spokePool_2,
      erc20: erc20_2,
      deploymentBlock: spokePool2DeploymentBlock,
    } = await deploySpokePoolWithToken(destinationChainId, originChainId));
    ({ hubPool, l1Token_1: l1Token } = await deployAndConfigureHubPool(owner, [
      { l2ChainId: destinationChainId, spokePool: spokePool_2 },
      { l2ChainId: originChainId, spokePool: spokePool_1 },
    ]));

    await enableRoutesOnHubPool(hubPool, [
      { destinationChainId: originChainId, l1Token, destinationToken: erc20_1 },
      { destinationChainId: destinationChainId, l1Token, destinationToken: erc20_2 },
    ]);

    const { spyLogger } = createSpyLogger();
    ({ configStore } = await deployConfigStore(owner, [l1Token]));
    hubPoolClient = new HubPoolClient(spyLogger, hubPool);
    configStoreClient = new AcrossConfigStoreClient(spyLogger, configStore, hubPoolClient);
    await hubPoolClient.update();
    await configStoreClient.update();
    spokePoolClient1 = new SpokePoolClient(
      spyLogger,
      spokePool_1,
      configStoreClient,
      originChainId,
      undefined,
      spokePool1DeploymentBlock
    );
    spokePoolClient2 = new SpokePoolClient(
      createSpyLogger().spyLogger,
      spokePool_2,
      null,
      destinationChainId,
      undefined,
      spokePool2DeploymentBlock
    );

    await setupTokensForWallet(spokePool_1, depositor, [erc20_1], null, 10);
    await setupTokensForWallet(spokePool_2, relayer, [erc20_2], null, 10);

    // Set the spokePool's time to the provider time. This is done to enable the block utility time finder identify a
    // "reasonable" block number based off the block time when looking at quote timestamps. We only need to do
    // this on the deposit chain because that chain's spoke pool client will have to fill in its realized lp fee %.
    await spokePool_1.setCurrentTime(await getLastBlockTime(spokePool_1.provider));
  });

  it("Accepts valid fills", async function () {
    await deposit(spokePool_1, erc20_1, depositor, depositor, destinationChainId);
    await fillRelay(spokePool_2, erc20_2, depositor, depositor, relayer, 0, originChainId);

    await spokePoolClient2.update();
    await spokePoolClient1.update();

    const [deposit_1] = spokePoolClient1.getDeposits();
    const [fill_1] = spokePoolClient2.getFills();

    // Some fields are expected to be dynamically populated by the client, but aren't in this environment.
    // Fill them in manually from the fill struct to get a valid comparison.
    expect(
      spokePoolClient2.validateFillForDeposit(fill_1, {
        ...deposit_1,
        realizedLpFeePct: fill_1.realizedLpFeePct,
        destinationToken: fill_1.destinationToken,
      })
    ).to.equal(true);
  });

  it("Returns deposit matched with fill", async function () {
    const deposit_1 = {
      ...(await deposit(spokePool_1, erc20_1, depositor, depositor, destinationChainId)),
      originBlockNumber: await getLastBlockNumber(),
      blockNumber: 0,
    };
    const fill_1 = await fillRelay(spokePool_2, erc20_2, depositor, depositor, relayer, 0, originChainId);

    const spokePoolClientForDestinationChain = new SpokePoolClient(
      createSpyLogger().spyLogger,
      spokePool_1,
      null,
      destinationChainId,
      undefined,
      spokePool1DeploymentBlock
    ); // create spoke pool client on the "target" chain.
    // expect(spokePoolClientForDestinationChain.getDepositForFill(fill_1)).to.equal(undefined);
    await spokePoolClientForDestinationChain.update();

    // Override the fill's realized LP fee % and destination token so that it matches the deposit's default zero'd
    // out values. The destination token and realized LP fee % are set by the spoke pool client by querying the hub pool
    // contract state, however this test ignores the rate model contract and therefore there is no hub pool contract
    // to query from, so they will be set to 0x0 and 0% respectively.
    const expectedDeposit = {
      ...deposit_1,
      destinationToken: zeroAddress,
      realizedLpFeePct: toBN(0),
    };
    expect(
      spokePoolClientForDestinationChain.getDepositForFill({
        ...fill_1,
        destinationToken: zeroAddress,
        realizedLpFeePct: toBN(0),
      })
    )
      .excludingEvery(["logIndex", "transactionIndex", "transactionHash"])
      .to.deep.equal(expectedDeposit);
  });

  it("binary search for deposit ID", async function () {
    // @dev In this test we mine random counts of block between deposits to "fuzz" test the binary search algo
    // which can produce different results depending on the total search range and where deposit events fall.

    // Send 2 deposits and mine blocks between them to ensure deposits are in different blocks.
    await deposit(spokePool_1, erc20_1, depositor, depositor, destinationChainId);
    await mineRandomBlocks();
    await deposit(spokePool_1, erc20_1, depositor, depositor, destinationChainId);
    await mineRandomBlocks();
    const [deposit0Event, deposit1Event] = await spokePool_1.queryFilter("FundsDeposited");
    const deposit0Block = deposit0Event.blockNumber;
    const deposit1Block = deposit1Event.blockNumber;

    // Set spoke pool client's fromBlock to be the latest block so that the binary search defaults the "high" block
    // to this. Otherwise the binary search should fail since the "high" block will default to the eventSearchConfig
    // fromBlock = 0.
    await assertPromiseError(
      spokePoolClient1.binarySearchForBlockContainingDepositId(0),
      "Binary search failed because low > high"
    );
    spokePoolClient1.eventSearchConfig.fromBlock = await spokePool_1.provider.getBlockNumber();
    // Searching for deposit ID 0 should cause the binary search to immediately exit and return the mid block
    // between the spoke pool deployment and the client's first block searched. This assumes the SpokePool's
    // numberOfDeposits started at 0.
    const firstMidBlockInBinarySearch = Math.floor(
      (spokePoolClient1.eventSearchConfig.fromBlock + spokePool1DeploymentBlock) / 2
    );
    expect(await spokePoolClient1.binarySearchForBlockContainingDepositId(0)).to.equal(firstMidBlockInBinarySearch);
    // Importantly, this block should be < the actual block of deposit 0.
    expect(firstMidBlockInBinarySearch).to.be.lessThan(deposit0Block);
    // Similarly, the block returned for deposit ID 1 should be < the actual block of deposit 1, and the block
    // returned for deposit ID 2 should be <= than the high block since its the last block in the binary search range.
    expect(await spokePoolClient1.binarySearchForBlockContainingDepositId(1)).to.be.lessThan(deposit1Block);
    expect(await spokePoolClient1.binarySearchForBlockContainingDepositId(1)).to.be.greaterThanOrEqual(deposit0Block);
    expect(await spokePoolClient1.binarySearchForBlockContainingDepositId(2)).to.be.lessThanOrEqual(
      spokePoolClient1.eventSearchConfig.fromBlock
    );
    expect(await spokePoolClient1.binarySearchForBlockContainingDepositId(2)).to.be.greaterThanOrEqual(deposit1Block);

    // Now send multiple deposits in the same block.
    const depositParams = getDepositParams(
      depositor.address,
      erc20_1.address,
      toBNWei("1"),
      destinationChainId,
      toBNWei("0.01"),
      await spokePool_1.getCurrentTime()
    );
    const depositData = await spokePool_1.populateTransaction.deposit(...depositParams);
    await spokePool_1.connect(depositor).multicall(Array(3).fill(depositData.data));
    expect(await spokePool_1.numberOfDeposits()).to.equal(5);
    const depositEvents = await spokePool_1.queryFilter("FundsDeposited");

    // Set fromBlock to block later than deposits.
    spokePoolClient1.eventSearchConfig.fromBlock = await spokePool_1.provider.getBlockNumber();

    // The binary search will now return the block where depositId incremented from the target-1 to the target, even
    // if calling `numberOfDeposits()` at the returned block is > target. This is because of the multiple deposits
    // in the same block.
    expect(await spokePoolClient1.binarySearchForBlockContainingDepositId(4)).to.be.greaterThanOrEqual(
      depositEvents[3].blockNumber
    );
    expect(await spokePoolClient1.binarySearchForBlockContainingDepositId(3)).to.be.greaterThanOrEqual(
      depositEvents[2].blockNumber
    );

    // Searching for deposit ID 5 should return same block as 4 and 3 since they were in same block:
    expect(await spokePoolClient1.binarySearchForBlockContainingDepositId(5)).to.be.greaterThanOrEqual(
      await spokePoolClient1.binarySearchForBlockContainingDepositId(4)
    );
    expect(await spokePoolClient1.binarySearchForBlockContainingDepositId(5)).to.be.greaterThanOrEqual(
      await spokePoolClient1.binarySearchForBlockContainingDepositId(3)
    );
    expect(await spokePoolClient1.binarySearchForBlockContainingDepositId(5)).to.be.lessThanOrEqual(
      spokePoolClient1.eventSearchConfig.fromBlock
    );

    // Deposit ID 2 should be strictly less than deposit ID 3
    expect(await spokePoolClient1.binarySearchForBlockContainingDepositId(2)).to.be.greaterThanOrEqual(
      depositEvents[1].blockNumber
    );
    expect(await spokePoolClient1.binarySearchForBlockContainingDepositId(2)).to.be.lessThan(
      depositEvents[3].blockNumber
    );

    // If we add some blocks to the end of the binary search, then the results will be the same when searching for
    // deposits in the same block.
    await mineRandomBlocks();
    spokePoolClient1.eventSearchConfig.fromBlock = await spokePool_1.provider.getBlockNumber();

    expect(await spokePoolClient1.binarySearchForBlockContainingDepositId(4)).to.be.greaterThanOrEqual(
      depositEvents[3].blockNumber
    );
    expect(await spokePoolClient1.binarySearchForBlockContainingDepositId(3)).to.be.greaterThanOrEqual(
      depositEvents[2].blockNumber
    );
    expect(await spokePoolClient1.binarySearchForBlockContainingDepositId(5)).to.be.greaterThanOrEqual(
      await spokePoolClient1.binarySearchForBlockContainingDepositId(4)
    );
    expect(await spokePoolClient1.binarySearchForBlockContainingDepositId(5)).to.be.greaterThanOrEqual(
      await spokePoolClient1.binarySearchForBlockContainingDepositId(3)
    );

    // Last deposit ID is now stricly less than last block in search range because there were more blocks mined since
    // the deposit that incrementerd ID from 4 to 5.
    expect(await spokePoolClient1.binarySearchForBlockContainingDepositId(5)).to.be.lessThan(
      spokePoolClient1.eventSearchConfig.fromBlock
    );

    expect(await spokePoolClient1.binarySearchForBlockContainingDepositId(2)).to.be.greaterThanOrEqual(
      depositEvents[1].blockNumber
    );
    expect(await spokePoolClient1.binarySearchForBlockContainingDepositId(2)).to.be.lessThan(
      depositEvents[3].blockNumber
    );
  });

  it("Can fetch older deposit matching fill", async function () {
    const depositData = await deposit(spokePool_1, erc20_1, depositor, depositor, destinationChainId);

    if (!depositData) throw new Error("Deposit data is null");
    const expectedRealizedLpFeePct = await configStoreClient.computeRealizedLpFeePct(
      {
        quoteTimestamp: depositData.quoteTimestamp,
        amount: depositData.amount,
        destinationChainId: depositData.destinationChainId,
        originChainId: depositData.originChainId,
      },
      l1Token.address
    );
    await fillRelay(
      spokePool_2,
      erc20_2,
      depositor,
      depositor,
      relayer,
      0,
      originChainId,
      depositData?.amount,
      depositData?.amount,
      expectedRealizedLpFeePct.realizedLpFeePct
    );
    await spokePoolClient2.update();
    const [fill] = spokePoolClient2.getFills();

    await assertPromiseError(spokePoolClient1.queryHistoricalDepositForFill(fill), "SpokePoolClient must be updated");

    // Set event search config from block to latest block so client doesn't see event.
    spokePoolClient1.eventSearchConfig.fromBlock = await spokePool_1.provider.getBlockNumber();
    spokePoolClient1.firstBlockToSearch = spokePoolClient1.eventSearchConfig.fromBlock;
    await spokePoolClient1.update();

    // Client has 0 deposits in memory so querying historical deposit sends fresh RPC requests.
    expect(spokePoolClient1.getDeposits().length).to.equal(0);
    const historicalDeposit = await spokePoolClient1.queryHistoricalDepositForFill(fill);
    expect(historicalDeposit?.depositId).to.deep.equal(depositData.depositId);
  });

  it("binary search for deposit ID", async function () {
    // Make sure depositID0 isn't minted in the same block as the contract deployment.
    await hre.network.provider.send("evm_mine");

    // Send 2 deposits and mine blocks between them to ensure deposits are in different blocks.
    await deposit(spokePool_1, erc20_1, depositor, depositor, destinationChainId);
    await hre.network.provider.send("evm_mine");
    await deposit(spokePool_1, erc20_1, depositor, depositor, destinationChainId);
    await hre.network.provider.send("evm_mine");
    const [deposit0Event, deposit1Event] = await spokePool_1.queryFilter("FundsDeposited");
    const deposit0Block = deposit0Event.blockNumber;
    const deposit1Block = deposit1Event.blockNumber;

    // Set spoke pool client's fromBlock to be the latest block so that the binary search defaults the "high" block
    // to this. Otherwise the binary search should fail since the "high" block will default to the eventSearchConfig
    // fromBlock = 0.
    await assertPromiseError(
      spokePoolClient1.binarySearchForBlockContainingDepositId(0),
      "Binary search failed because low > high"
    );
    spokePoolClient1.eventSearchConfig.fromBlock = await spokePool_1.provider.getBlockNumber();
    // Searching for deposit ID 0 should cause the binary search to immediately exit and return the mid block
    // between the spoke pool deployment and the client's first block searched. This assumes the SpokePool's
    // numberOfDeposits started at 0.
    const firstMidBlockInBinarySearch = Math.floor(
      (spokePoolClient1.eventSearchConfig.fromBlock + spokePool1DeploymentBlock) / 2
    );
    expect(await spokePoolClient1.binarySearchForBlockContainingDepositId(0)).to.equal(firstMidBlockInBinarySearch);
    // Importantly, this block should be < the actual block of deposit 0.
    expect(firstMidBlockInBinarySearch).to.be.lessThan(deposit0Block);
    expect(await spokePoolClient1.binarySearchForBlockContainingDepositId(1)).to.be.lessThan(deposit1Block);
    expect(await spokePoolClient1.binarySearchForBlockContainingDepositId(2)).to.be.lessThan(
      spokePoolClient1.eventSearchConfig.fromBlock
    );

    // Now send multiple deposits in the same block.
    const depositParams = getDepositParams(
      depositor.address,
      erc20_1.address,
      toBNWei("1"),
      destinationChainId,
      toBNWei("0.01"),
      await spokePool_1.getCurrentTime()
    );
    const depositData = await spokePool_1.populateTransaction.deposit(...depositParams);
    await spokePool_1.connect(depositor).multicall(Array(3).fill(depositData.data));
    expect(await spokePool_1.numberOfDeposits()).to.equal(5);
    const depositEvents = await spokePool_1.queryFilter("FundsDeposited");

    // Set fromBlock to block later than deposits.
    spokePoolClient1.eventSearchConfig.fromBlock = await spokePool_1.provider.getBlockNumber();

    // This test fails because the same block where depositID went from 3-->4 is also when depositID went from
    // 4-->5 so the test falls out of the while loop.
    // await spokePoolClient1.binarySearchForBlockContainingDepositId(4);
    await assertPromiseError(
      spokePoolClient1.binarySearchForBlockContainingDepositId(4),
      "failed to find block containing deposit ID"
    );
    // We can avoid the error by instructing the binary search to fallback to the last set high or low block which should be greater than or
    // less than the actual block we wanted.
    expect(await spokePoolClient1.binarySearchForBlockContainingDepositId(4, "LOW")).to.be.lessThanOrEqual(
      depositEvents[4].blockNumber
    );
    expect(await spokePoolClient1.binarySearchForBlockContainingDepositId(4, "HIGH")).to.be.greaterThanOrEqual(
      depositEvents[4].blockNumber
    );

    // When looking for deposit ID 2, we will be able to find the actual block number which will be equal to the block
    // that emitted deposit ID 1.
    expect(await spokePoolClient1.binarySearchForBlockContainingDepositId(2, "LOW")).to.be.equal(
      depositEvents[1].blockNumber
    );
    expect(await spokePoolClient1.binarySearchForBlockContainingDepositId(2, "HIGH")).to.be.equal(
      depositEvents[1].blockNumber
    );

    // Deposit ID for 5 should work as expected.
    expect(await spokePoolClient1.binarySearchForBlockContainingDepositId(5, "LOW")).to.be.equal(
      depositEvents[4].blockNumber
    );
    expect(await spokePoolClient1.binarySearchForBlockContainingDepositId(5, "HIGH")).to.be.equal(
      depositEvents[4].blockNumber
    );

    // If we add some blocks to the end of the binary search, then the results will be the same when searching for
    // deposits in the same block.
    await hre.network.provider.send("evm_mine");
    await hre.network.provider.send("evm_mine");
    spokePoolClient1.eventSearchConfig.fromBlock = await spokePool_1.provider.getBlockNumber();

    expect(await spokePoolClient1.binarySearchForBlockContainingDepositId(5, "LOW")).to.be.equal(
      depositEvents[4].blockNumber
    );
    expect(await spokePoolClient1.binarySearchForBlockContainingDepositId(5, "HIGH")).to.be.equal(
      depositEvents[4].blockNumber
    );
    expect(await spokePoolClient1.binarySearchForBlockContainingDepositId(4, "LOW")).to.be.lessThanOrEqual(
      depositEvents[4].blockNumber
    );
    expect(await spokePoolClient1.binarySearchForBlockContainingDepositId(4, "HIGH")).to.be.greaterThanOrEqual(
      depositEvents[4].blockNumber
    );
    expect(await spokePoolClient1.binarySearchForBlockContainingDepositId(3, "LOW")).to.be.lessThanOrEqual(
      depositEvents[4].blockNumber
    );
    expect(await spokePoolClient1.binarySearchForBlockContainingDepositId(3, "HIGH")).to.be.greaterThanOrEqual(
      depositEvents[4].blockNumber
    );
    expect(await spokePoolClient1.binarySearchForBlockContainingDepositId(2, "LOW")).to.be.equal(
      depositEvents[1].blockNumber
    );
    expect(await spokePoolClient1.binarySearchForBlockContainingDepositId(2, "HIGH")).to.be.equal(
      depositEvents[1].blockNumber
    );
  });

  it("Can fetch older deposit matching fill", async function () {
    const depositData = await deposit(spokePool_1, erc20_1, depositor, depositor, destinationChainId);

    if (!depositData) throw new Error("Deposit data is null");
    const expectedRealizedLpFeePct = await configStoreClient.computeRealizedLpFeePct(
      {
        quoteTimestamp: depositData.quoteTimestamp,
        amount: depositData.amount,
        destinationChainId: depositData.destinationChainId,
        originChainId: depositData.originChainId,
      },
      l1Token.address
    );
    await fillRelay(
      spokePool_2,
      erc20_2,
      depositor,
      depositor,
      relayer,
      0,
      originChainId,
      depositData?.amount,
      depositData?.amount,
      expectedRealizedLpFeePct.realizedLpFeePct
    );
    await spokePoolClient2.update();
    const [fill] = spokePoolClient2.getFills();

    await assertPromiseError(spokePoolClient1.queryHistoricalDepositForFill(fill), "SpokePoolClient must be updated");

    // Set event search config from block to latest block so client doesn't see event.
    spokePoolClient1.eventSearchConfig.fromBlock = await spokePool_1.provider.getBlockNumber();
    spokePoolClient1.firstBlockToSearch = spokePoolClient1.eventSearchConfig.fromBlock;
    await spokePoolClient1.update();

    // Client has 0 deposits in memory so querying historical deposit sends fresh RPC requests.
    expect(spokePoolClient1.getDeposits().length).to.equal(0);
    const historicalDeposit = await spokePoolClient1.queryHistoricalDepositForFill(fill);
    expect(historicalDeposit?.depositId).to.deep.equal(depositData.depositId);
  });

  it("Ignores fills with deposit ID > latest deposit ID queried in spoke pool client", async function () {
    // This test case makes sure that spoke pool client gracefully handles case where it can't historically search
    // for the deposit ID because its greater than the spoke pool client's highest deposit ID.

    // Send a real deposit so client sets its earliestDepositIdQueried=0. This means that
    // `queryHistoricalDepositForFill` should exit early when given a fill with deposit ID >= 0. This is because the
    // caller should just call getFillForDeposit() in these cases.
    const deposit = await buildDeposit(
      configStoreClient,
      hubPoolClient,
      spokePool_1,
      erc20_1,
      l1Token,
      depositor,
      destinationChainId
    );

    // Send invalid fill with overridden deposit ID.
    const fill = await buildFill(spokePool_2, erc20_2, depositor, relayer, { ...deposit, depositId: 333 }, 1);
    await spokePoolClient1.update();
    expect(spokePoolClient1.earliestDepositIdQueried >= deposit.depositId).is.true;
    expect(await spokePoolClient1.queryHistoricalDepositForFill(fill)).to.equal(undefined);

    // The caller should just call getFillForDeposit() for these deposit Ids.
    expect(spokePoolClient1.getDeposits().length).to.equal(1);
  });

  it("Ignores fills with deposit ID < first deposit ID in spoke pool", async function () {
    // For this test, the client should exit early based on the fill.depositId so we don't need to send
    // a deposit on chain.
    await fillRelay(
      spokePool_2,
      erc20_2,
      depositor,
      depositor,
      relayer,
      0,
      originChainId,
      toBNWei("1"),
      toBNWei("1"),
      toBNWei("0.01")
    );
    await spokePoolClient2.update();
    const [fill] = spokePoolClient2.getFills();

    // Override the first spoke pool deposit ID that the client thinks is available in the contract.
    await spokePoolClient1.update();
    spokePoolClient1.firstDepositIdForSpokePool = 1;
    expect(fill.depositId < spokePoolClient1.firstDepositIdForSpokePool).is.true;
    expect(await spokePoolClient1.queryHistoricalDepositForFill(fill)).to.equal(undefined);
  });

  it("Returns sped up deposit matched with fill", async function () {
    const deposit_1 = {
      ...(await deposit(spokePool_1, erc20_1, depositor, depositor, destinationChainId)),
      originBlockNumber: await getLastBlockNumber(),
      blockNumber: 0,
    };
    // Override the fill's realized LP fee % and destination token so that it matches the deposit's default zero'd
    // out values. The destination token and realized LP fee % are set by the spoke pool client by querying the hub pool
    // contract state, however this test ignores the rate model contract and therefore there is no hub pool contract
    // to query from, so they will be set to 0x0 and 0% respectively.
    const expectedDeposit = {
      ...deposit_1,
      destinationToken: zeroAddress,
      realizedLpFeePct: toBN(0),
    };
    const fill_1 = await buildFill(spokePool_2, erc20_2, depositor, relayer, expectedDeposit, 0.2);
    const fill_2 = await buildModifiedFill(spokePool_2, depositor, relayer, fill_1, 2, 0.2); // Fill same % of deposit with 2x larger relayer fee pct.

    const spokePoolClientForDestinationChain = new SpokePoolClient(
      createSpyLogger().spyLogger,
      spokePool_1,
      null,
      destinationChainId,
      undefined,
      spokePool2DeploymentBlock
    ); // create spoke pool client on the "target" chain.
    await spokePoolClientForDestinationChain.update();

    expect(fill_1.appliedRelayerFeePct.eq(fill_2.appliedRelayerFeePct)).to.be.false;
    expect(
      spokePoolClientForDestinationChain.getDepositForFill({
        ...fill_1,
        destinationToken: zeroAddress,
        realizedLpFeePct: toBN(0),
      })
    )
      .excludingEvery(["logIndex", "transactionIndex", "transactionHash"])
      .to.deep.equal(expectedDeposit);
    expect(
      spokePoolClientForDestinationChain.getDepositForFill({
        ...fill_2,
        destinationToken: zeroAddress,
        realizedLpFeePct: toBN(0),
      })
    )
      .excludingEvery(["logIndex", "transactionIndex", "transactionHash"])
      .to.deep.equal(expectedDeposit);
  });

  it("Rejects fills that dont match the deposit data", async function () {
    await deposit(spokePool_1, erc20_1, depositor, depositor, destinationChainId);
    await fillRelay(spokePool_2, erc20_2, depositor, depositor, relayer, 0, originChainId);

    await spokePoolClient2.update();
    await spokePoolClient1.update();

    const [incompleteDeposit] = spokePoolClient1.getDeposits();
    const [validFill] = spokePoolClient2.getFills();
    const validDeposit = {
      ...incompleteDeposit,
      realizedLpFeePct: validFill.realizedLpFeePct,
      destinationToken: validFill.destinationToken,
    };

    // Invalid Amount.
    expect(spokePoolClient2.validateFillForDeposit({ ...validFill, amount: toBNWei(1337) }, validDeposit)).to.be.false;

    // Invalid depositId.
    expect(spokePoolClient2.validateFillForDeposit({ ...validFill, depositId: 1337 }, validDeposit)).to.be.false;

    // Changed the depositor.
    expect(spokePoolClient2.validateFillForDeposit({ ...validFill, depositor: relayer.address }, validDeposit)).to.be
      .false;

    // Changed the recipient.
    expect(spokePoolClient2.validateFillForDeposit({ ...validFill, recipient: relayer.address }, validDeposit)).to.be
      .false;

    // Changed the relayerFeePct.
    expect(spokePoolClient2.validateFillForDeposit({ ...validFill, relayerFeePct: toBNWei(1337) }, validDeposit)).to.be
      .false;

    // Validate the realizedLPFeePct and destinationToken matches. These values are optional in the deposit object and
    // are assigned during the update method, which is not polled in this set of tests.

    // Assign a realizedLPFeePct to the deposit and check it matches with the fill. The default set on a fill (from
    // contracts-v2) is 0.1. After, try changing this to a separate value and ensure this is rejected.
    expect(spokePoolClient2.validateFillForDeposit(validFill, { ...validDeposit, realizedLpFeePct: toBNWei(0.1) })).to
      .be.true;

    expect(spokePoolClient2.validateFillForDeposit(validFill, { ...validDeposit, realizedLpFeePct: toBNWei(0.1337) }))
      .to.be.false;

    // Assign a destinationToken to the deposit and ensure it is validated correctly. erc20_2 from the fillRelay method
    // above is the destination token. After, try changing this to something that is clearly wrong.
    expect(spokePoolClient2.validateFillForDeposit(validFill, { ...validDeposit, destinationToken: erc20_2.address }))
      .to.be.true;
    expect(spokePoolClient2.validateFillForDeposit(validFill, { ...validDeposit, destinationToken: owner.address })).to
      .be.false;
  });
});
