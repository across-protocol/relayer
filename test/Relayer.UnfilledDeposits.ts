import * as contracts from "@across-protocol/contracts/dist/test-utils";
import { ExpandedERC20__factory as ERC20 } from "@across-protocol/contracts";
import { utils as sdkUtils } from "@across-protocol/sdk";
import {
  AcrossApiClient,
  ConfigStoreClient,
  HubPoolClient,
  MultiCallerClient,
  SpokePoolClient,
  TokenClient,
} from "../src/clients";
import { DepositWithBlock, FillStatus } from "../src/interfaces";
import {
  CHAIN_ID_TEST_LIST,
  amountToLp,
  defaultMinDepositConfirmations,
  originChainId,
  destinationChainId,
  repaymentChainId,
} from "./constants";
import { MockInventoryClient, MockProfitClient, MockConfigStoreClient, MockedMultiCallerClient } from "./mocks";
import {
  BigNumber,
  Contract,
  SignerWithAddress,
  createSpyLogger,
  deployAndConfigureHubPool,
  deployConfigStore,
  deploySpokePoolWithToken,
  depositV3,
  fillV3Relay,
  enableRoutesOnHubPool,
  ethers,
  expect,
  getLastBlockTime,
  lastSpyLogIncludes,
  randomAddress,
  setupTokensForWallet,
} from "./utils";

// Tested
import { Relayer } from "../src/relayer/Relayer";
import { RelayerConfig } from "../src/relayer/RelayerConfig";
import { RelayerUnfilledDeposit, getAllUnfilledDeposits, getUnfilledDeposits, utf8ToHex } from "../src/utils";

describe("Relayer: Unfilled Deposits", async function () {
  const { bnOne } = sdkUtils;

  let spokePool_1: Contract, erc20_1: Contract, spokePool_2: Contract, erc20_2: Contract;
  let hubPool: Contract, l1Token: Contract, configStore: Contract;
  let owner: SignerWithAddress, depositor: SignerWithAddress, relayer: SignerWithAddress;

  let spokePoolClient_1: SpokePoolClient, spokePoolClient_2: SpokePoolClient;
  let configStoreClient: MockConfigStoreClient, hubPoolClient: HubPoolClient;
  let spokePoolClients: Record<number, SpokePoolClient>;
  let multiCallerClient: MultiCallerClient, tryMulticallClient: MultiCallerClient, tokenClient: TokenClient;
  let profitClient: MockProfitClient;
  let spokePool1DeploymentBlock: number, spokePool2DeploymentBlock: number;

  let relayerInstance: Relayer;
  let unfilledDeposits: RelayerUnfilledDeposit[] = [];
  let inputAmount: BigNumber, outputAmount: BigNumber;

  let _getAllUnfilledDeposits: () => RelayerUnfilledDeposit[];

  const { spy, spyLogger } = createSpyLogger();
  const updateAllClients = async () => {
    await configStoreClient.update();
    await hubPoolClient.update();
    await tokenClient.update();
    await spokePoolClient_1.update();
    await spokePoolClient_2.update();
  };

  beforeEach(async function () {
    [owner, depositor, relayer] = await ethers.getSigners();
    // Deploy the two spokePools and their associated tokens. Set the chainId to match to associated chainIds. The first
    // prop is the chainId set on the spoke pool. The second prop is the chain ID enabled in the route on the spokePool.
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
      { l2ChainId: originChainId, spokePool: spokePool_1 },
      { l2ChainId: destinationChainId, spokePool: spokePool_2 },
      { l2ChainId: repaymentChainId, spokePool: spokePool_2 },
      { l2ChainId: 1, spokePool: spokePool_2 },
    ]));

    ({ configStore } = await deployConfigStore(owner, [l1Token]));

    configStoreClient = new MockConfigStoreClient(spyLogger, configStore, undefined, undefined, CHAIN_ID_TEST_LIST);
    await configStoreClient.update();

    hubPoolClient = new HubPoolClient(spyLogger, hubPool, configStoreClient);
    await hubPoolClient.update();

    spokePoolClient_1 = new SpokePoolClient(
      spyLogger,
      spokePool_1,
      hubPoolClient,
      originChainId,
      spokePool1DeploymentBlock
    );
    spokePoolClient_2 = new SpokePoolClient(
      spyLogger,
      spokePool_2,
      hubPoolClient,
      destinationChainId,
      spokePool2DeploymentBlock,
      { fromBlock: 0, toBlock: undefined, maxBlockLookBack: 0 }
    );

    spokePoolClients = { [originChainId]: spokePoolClient_1, [destinationChainId]: spokePoolClient_2 };
    multiCallerClient = new MockedMultiCallerClient(spyLogger);
    tryMulticallClient = new MockedMultiCallerClient(spyLogger);
    tokenClient = new TokenClient(spyLogger, relayer.address, spokePoolClients, hubPoolClient);
    profitClient = new MockProfitClient(spyLogger, hubPoolClient, spokePoolClients, []);
    await profitClient.initToken(l1Token);

    const chainIds = Object.values(spokePoolClients).map(({ chainId }) => chainId);
    relayerInstance = new Relayer(
      relayer.address,
      spyLogger,
      {
        spokePoolClients,
        hubPoolClient,
        configStoreClient: configStoreClient as unknown as ConfigStoreClient,
        profitClient,
        tokenClient,
        multiCallerClient,
        inventoryClient: new MockInventoryClient(null, null, null, null, null, hubPoolClient),
        acrossApiClient: new AcrossApiClient(spyLogger, hubPoolClient, chainIds),
        tryMulticallClient,
      },
      {
        relayerTokens: [],
        minDepositConfirmations: defaultMinDepositConfirmations,
        acceptInvalidFills: false,
        tryMulticallChains: [],
      } as unknown as RelayerConfig
    );

    const weth = undefined;
    await setupTokensForWallet(spokePool_1, owner, [l1Token], weth, 100); // seed the owner to LP.
    await setupTokensForWallet(spokePool_1, depositor, [erc20_1], weth, 100); // seed the depositor to LP.
    await setupTokensForWallet(spokePool_2, depositor, [erc20_2], weth, 10);
    await setupTokensForWallet(spokePool_1, relayer, [erc20_1], weth, 10);
    await setupTokensForWallet(spokePool_2, relayer, [erc20_2], weth, 10);

    // Approve and add liquidity.
    await enableRoutesOnHubPool(hubPool, [
      { destinationChainId: originChainId, l1Token, destinationToken: erc20_1 },
      { destinationChainId: destinationChainId, l1Token, destinationToken: erc20_2 },
    ]);
    await l1Token.approve(hubPool.address, amountToLp);
    await hubPool.addLiquidity(l1Token.address, amountToLp);

    const currentTime = await getLastBlockTime(spokePool_1.provider);
    await Promise.all([spokePool_1, spokePool_2].map((spokePool) => spokePool.setCurrentTime(currentTime)));
    await updateAllClients();

    _getAllUnfilledDeposits = (): RelayerUnfilledDeposit[] =>
      Object.values(getAllUnfilledDeposits(relayerInstance.clients.spokePoolClients, hubPoolClient)).flat();
    unfilledDeposits = [];

    const tokenBalance = await erc20_1.balanceOf(depositor.address);
    outputAmount = tokenBalance.div(100);
    inputAmount = outputAmount.mul(101).div(100);
  });

  it("Correctly fetches unfilled deposits", async function () {
    const deposits = await sdkUtils.mapAsync(
      [
        { spokePool: spokePool_1, chainId: destinationChainId, inputToken: erc20_1, outputToken: erc20_2 },
        { spokePool: spokePool_2, chainId: originChainId, inputToken: erc20_2, outputToken: erc20_1 },
      ],
      async ({ spokePool, chainId: dstChainId, inputToken: inToken, outputToken: outToken }) => {
        const inputToken = inToken.address;
        const outputToken = outToken.address;
        return depositV3(spokePool, dstChainId, depositor, inputToken, inputAmount, outputToken, outputAmount);
      }
    );
    await updateAllClients();

    unfilledDeposits = _getAllUnfilledDeposits();
    expect(unfilledDeposits)
      .excludingEvery(["realizedLpFeePct", "quoteBlockNumber", "fromLiteChain", "toLiteChain"])
      .to.deep.equal(
        [...deposits]
          .sort((a, b) => (a.destinationChainId > b.destinationChainId ? 1 : -1))
          .map((deposit) => ({
            deposit,
            unfilledAmount: deposit.outputAmount,
            invalidFills: [],
            version: configStoreClient.configStoreVersion,
          }))
      );
  });

  it("Correctly uses input fill status", async function () {
    const deposits: DepositWithBlock[] = [];
    for (let i = 0; i < 5; ++i) {
      const deposit = await depositV3(
        spokePool_1,
        destinationChainId,
        depositor,
        erc20_1.address,
        inputAmount,
        erc20_2.address,
        outputAmount
      );
      deposits.push(deposit);
    }
    await updateAllClients();

    // Take the 2nd last deposit and mark it filled.
    expect(deposits.length > 2).to.be.true;
    const filledDeposit = deposits.at(-2);
    expect(filledDeposit).to.exist;

    const depositHash = spokePoolClient_1.getDepositHash(filledDeposit!);
    const { fillStatus } = relayerInstance;
    fillStatus[depositHash] = FillStatus.Filled;

    unfilledDeposits = getUnfilledDeposits(destinationChainId, spokePoolClients, hubPoolClient, fillStatus);
    expect(unfilledDeposits)
      .excludingEvery(["realizedLpFeePct", "quoteBlockNumber", "fromLiteChain", "toLiteChain"])
      .to.deep.equal(
        deposits
          .filter(({ depositId }) => depositId !== filledDeposit!.depositId)
          .map((deposit) => ({
            deposit,
            unfilledAmount: deposit.outputAmount,
            invalidFills: [],
            version: configStoreClient.configStoreVersion,
          }))
      );
  });

  it("Correctly excludes fills that are incorrectly applied to a deposit", async function () {
    const deposit = await depositV3(
      spokePool_1,
      destinationChainId,
      depositor,
      erc20_1.address,
      inputAmount,
      erc20_2.address,
      outputAmount
    );

    // Make an invalid fills by tweaking outputAmount and depositId, respectively.
    const fakeDeposit = { ...deposit, outputAmount: deposit.outputAmount.sub(bnOne) };
    const invalidFill = await fillV3Relay(spokePool_2, fakeDeposit, relayer);
    const wrongDepositId = { ...deposit, depositId: deposit.depositId.add(1) };
    await fillV3Relay(spokePool_2, wrongDepositId, relayer);

    // The deposit should show up as unfilled, since the fill was incorrectly applied to the wrong deposit.
    await updateAllClients();
    unfilledDeposits = _getAllUnfilledDeposits();
    expect(unfilledDeposits)
      .excludingEvery(["realizedLpFeePct", "quoteBlockNumber", "fromLiteChain", "toLiteChain"])
      .to.deep.equal([
        {
          deposit: {
            ...deposit,
            depositId: sdkUtils.toBN(deposit.depositId),
          },
          unfilledAmount: deposit.outputAmount,
          invalidFills: [
            {
              ...invalidFill,
              depositId: sdkUtils.toBN(invalidFill.depositId),
            },
          ],
          version: configStoreClient.configStoreVersion,
        },
      ]);
  });

  it("Correctly selects unfilled deposit with updated fee", async function () {
    const delta = await spokePool_1.depositQuoteTimeBuffer(); // seconds

    // perform simple deposit
    const deposit1 = await depositV3(
      spokePool_1,
      destinationChainId,
      depositor,
      erc20_1.address,
      inputAmount,
      erc20_2.address,
      outputAmount
    );

    // Add an "early" deposit
    await spokePool_1.setCurrentTime(deposit1.quoteTimestamp + delta);
    const deposit2 = await depositV3(
      spokePool_1,
      destinationChainId,
      depositor,
      erc20_1.address,
      inputAmount,
      erc20_2.address,
      outputAmount
    );
    await spokePool_1.setCurrentTime(deposit1.quoteTimestamp);
    await updateAllClients();

    // Update the deposit before either is filled.
    const updatedOutputAmount = outputAmount.sub(bnOne);
    for (const deposit of [deposit1, deposit2]) {
      const signature = await contracts.getUpdatedV3DepositSignature(
        depositor,
        deposit.depositId,
        originChainId,
        updatedOutputAmount,
        sdkUtils.toBytes32(deposit.recipient),
        deposit.message
      );

      await spokePool_1
        .connect(depositor)
        .speedUpDeposit(
          sdkUtils.toBytes32(depositor.address),
          deposit.depositId,
          updatedOutputAmount,
          sdkUtils.toBytes32(deposit.recipient),
          deposit.message,
          signature
        );
    }
    await spokePoolClient_1.update();

    unfilledDeposits = _getAllUnfilledDeposits();

    // Expect both unfilled deposits. The SpokePool contract guarantees
    // that the quoteTimestamp can't be ahead of SpokePool time.
    expect(unfilledDeposits.length).to.eq(2);
    [deposit1, deposit2].forEach((deposit, idx) => {
      const unfilledDeposit = unfilledDeposits[idx];
      expect(unfilledDeposit.deposit.depositId).to.equal(deposit.depositId);

      // expect unfilled deposit to have the same outputAmount, but a lower updatedOutputAmount.
      expect(unfilledDeposit.deposit.outputAmount).to.deep.eq(outputAmount);
      expect(unfilledDeposit.deposit.updatedOutputAmount).to.deep.eq(updatedOutputAmount);
    });
  });

  it("Does not double fill deposit when updating fee after fill", async function () {
    const deposit = await depositV3(
      spokePool_1,
      destinationChainId,
      depositor,
      erc20_1.address,
      inputAmount,
      erc20_2.address,
      outputAmount
    );

    await updateAllClients();
    unfilledDeposits = _getAllUnfilledDeposits();
    expect(unfilledDeposits.length).to.equal(1);
    await fillV3Relay(spokePool_2, deposit, relayer);

    await updateAllClients();
    unfilledDeposits = _getAllUnfilledDeposits();
    expect(unfilledDeposits.length).to.equal(0);

    // Speed up deposit, and check that unfilled amount is still the same.
    const updatedOutputAmount = deposit.outputAmount.sub(bnOne);
    const signature = await contracts.getUpdatedV3DepositSignature(
      depositor,
      deposit.depositId,
      originChainId,
      updatedOutputAmount,
      sdkUtils.toBytes32(deposit.recipient),
      deposit.message
    );

    await spokePool_1
      .connect(depositor)
      .speedUpDeposit(
        sdkUtils.toBytes32(depositor.address),
        deposit.depositId,
        updatedOutputAmount,
        sdkUtils.toBytes32(deposit.recipient),
        deposit.message,
        signature
      );
    await updateAllClients();

    unfilledDeposits = _getAllUnfilledDeposits();
    expect(unfilledDeposits.length).to.equal(0);
  });

  it("Batch-computes LP fees correctly", async function () {
    const nLoops = 25;
    const [lpTokenAddr] = await hubPool.pooledTokens(l1Token.address);
    const lpToken = new Contract(lpTokenAddr, ERC20.abi, owner);

    const deposits: DepositWithBlock[] = [];
    for (let i = 0; i < nLoops; ++i) {
      // HubPool and origin SpokePool timestamps must be synchronised for quoteTimestamp validation.
      const quoteTimestamp = (await hubPool.provider.getBlock("latest")).timestamp;
      await spokePool_1.setCurrentTime(quoteTimestamp);

      const deposit = await depositV3(
        spokePool_1,
        destinationChainId,
        depositor,
        erc20_1.address,
        inputAmount.add(i),
        erc20_2.address,
        outputAmount,
        { quoteTimestamp }
      );
      deposits.push(deposit);

      // Modify the HubPool LP balance to ensure that subsequent deposits will receive a different LP fee.
      const lpTokenBalance = await lpToken.balanceOf(owner.address);
      (await hubPool.removeLiquidity(l1Token.address, lpTokenBalance.div(2), false)).wait();
    }
    await hubPoolClient.update();

    // Get the relayer's LP fee computation for repayment on both destination and HubPool chains.
    const relayerLpFees = await relayerInstance.batchComputeLpFees(deposits);

    // Compute LP fees for taking repayment on the HubPool chain.
    let hubPoolLpFees = await hubPoolClient.batchComputeRealizedLpFeePct(
      deposits.map((deposit) => ({ ...deposit, paymentChainId: destinationChainId }))
    );

    // Verify LP fees for repayment on the destination chain.
    deposits.forEach((deposit, idx) => {
      const lpFeeKey = relayerInstance.getLPFeeKey(deposit);
      const relayerLpFee = relayerLpFees[lpFeeKey].find(({ paymentChainId }) => paymentChainId === destinationChainId);
      expect(relayerLpFee).to.exist;
      expect(relayerLpFee!.lpFeePct.eq(hubPoolLpFees[idx].realizedLpFeePct)).to.be.true;
    });

    // Compute LP fees for taking repayment on the origin chain.
    hubPoolLpFees = await hubPoolClient.batchComputeRealizedLpFeePct(
      deposits.map((deposit) => ({ ...deposit, paymentChainId: originChainId }))
    );

    // Verify LP fees for repayment on the origin chain.
    deposits.forEach((deposit, idx) => {
      const lpFeeKey = relayerInstance.getLPFeeKey(deposit);
      const relayerLpFee = relayerLpFees[lpFeeKey].find(({ paymentChainId }) => paymentChainId === originChainId);
      expect(relayerLpFee).to.exist;
      expect(relayerLpFee!.lpFeePct.eq(hubPoolLpFees[idx].realizedLpFeePct)).to.be.true;
    });

    // Compute LP fees for taking repayment on the HubPool chain.
    hubPoolLpFees = await hubPoolClient.batchComputeRealizedLpFeePct(
      deposits.map((deposit) => ({ ...deposit, paymentChainId: hubPoolClient.chainId }))
    );

    // Verify LP fees for repayment on the HubPool chain.
    deposits.forEach((deposit, idx) => {
      const lpFeeKey = relayerInstance.getLPFeeKey(deposit);
      const relayerLpFee = relayerLpFees[lpFeeKey].find(
        ({ paymentChainId }) => paymentChainId === hubPoolClient.chainId
      );
      expect(relayerLpFee).to.exist;
      expect(relayerLpFee!.lpFeePct.eq(hubPoolLpFees[idx].realizedLpFeePct)).to.be.true;
    });

    // Test for collisions on the LP fee key.
    const [deposit] = deposits;
    let lpFeeKey = relayerInstance.getLPFeeKey(deposit);
    expect(relayerLpFees[lpFeeKey]).to.exist;

    lpFeeKey = relayerInstance.getLPFeeKey({ ...deposit, originChainId: destinationChainId });
    expect(relayerLpFees[lpFeeKey]).not.exist;

    lpFeeKey = relayerInstance.getLPFeeKey({ ...deposit, inputToken: randomAddress() });
    expect(relayerLpFees[lpFeeKey]).to.not.exist;

    lpFeeKey = relayerInstance.getLPFeeKey({ ...deposit, inputAmount: deposit.inputAmount.add(1) });
    expect(relayerLpFees[lpFeeKey]).to.not.exist;

    lpFeeKey = relayerInstance.getLPFeeKey({ ...deposit, quoteTimestamp: deposit.quoteTimestamp - 1 });
    expect(relayerLpFees[lpFeeKey]).to.not.exist;
  });

  it("Skip invalid fills from the same relayer", async function () {
    const deposit = await depositV3(
      spokePool_1,
      destinationChainId,
      depositor,
      erc20_1.address,
      inputAmount,
      erc20_2.address,
      outputAmount
    );

    // Make a fill with a different outputAmount. This fill should be
    // considered invalid and getAllUnfilledDeposits should log it.
    const invalidFill = await fillV3Relay(
      spokePool_2,
      { ...deposit, outputAmount: deposit.outputAmount.sub(bnOne) },
      relayer
    );
    await updateAllClients();

    // getUnfilledDeposit still returns the deposit as unfilled but with the invalid fill.
    unfilledDeposits = _getAllUnfilledDeposits();
    expect(unfilledDeposits)
      .excludingEvery(["realizedLpFeePct", "quoteBlockNumber", "fromLiteChain", "toLiteChain"])
      .to.deep.equal([
        {
          deposit: {
            ...deposit,
            depositId: sdkUtils.toBN(deposit.depositId),
          },
          unfilledAmount: deposit.outputAmount,
          invalidFills: [
            {
              ...invalidFill,
              depositId: sdkUtils.toBN(invalidFill.depositId),
            },
          ],
          version: configStoreClient.configStoreVersion,
        },
      ]);
    expect(lastSpyLogIncludes(spy, "Invalid fills found")).to.be.true;

    await relayerInstance.checkForUnfilledDepositsAndFill();
    // Relayer shouldn't try to fill again because there has been one invalid fill from this same relayer.
    expect(
      spy
        .getCalls()
        .find(({ lastArg }) => lastArg.message.includes("Skipping deposit with invalid fills from the same relayer"))
    ).to.not.be.undefined;
    expect(multiCallerClient.transactionCount()).to.equal(0);
  });

  it("Skip deposits we don't have updated config store version for", async function () {
    const highVersion = 1;
    // Set up test so that the latest version in the config store contract is higher than
    // the version in the config store client.
    const update = await configStore.updateGlobalConfig(utf8ToHex("VERSION"), `${highVersion}`);
    const updateTime = (await configStore.provider.getBlock(update.blockNumber)).timestamp;
    configStoreClient.setConfigStoreVersion(highVersion - 1);

    // Now send a deposit after the update time. This deposit should be skipped as we don't have the latest
    // version at the quote timestamp.
    await spokePool_1.setCurrentTime(updateTime + 1);
    await updateAllClients();

    await depositV3(
      spokePool_1,
      destinationChainId,
      depositor,
      erc20_1.address,
      inputAmount,
      erc20_2.address,
      outputAmount
    );
    await updateAllClients();

    const unfilledDeposits = _getAllUnfilledDeposits();
    expect(unfilledDeposits.length).to.equal(1);
    expect(unfilledDeposits[0].version).to.equal(highVersion);

    // Relayer class should filter out based on its highest supported version.
    await relayerInstance.checkForUnfilledDepositsAndFill();
    expect(multiCallerClient.transactionCount()).to.equal(0);
  });
});
