import {
  expect,
  ethers,
  Contract,
  SignerWithAddress,
  setupTokensForWallet,
  signForSpeedUp,
  toBNWei,
  deepEqualsWithBigNumber,
} from "./utils";
import { deploySpokePoolWithToken, enableRoutes, simpleDeposit, originChainId, createSpyLogger } from "./utils";
import { depositRelayerFeePct, destinationChainId } from "./constants";

import { SpokePoolClient } from "../src/clients";
import { DepositWithBlock } from "../src/interfaces";

let spokePool: Contract, erc20: Contract, destErc20: Contract, weth: Contract;
let depositor: SignerWithAddress, deploymentBlock: number;
const destinationChainId2 = destinationChainId + 1;

let spokePoolClient: SpokePoolClient;

describe("SpokePoolClient: SpeedUp", async function () {
  beforeEach(async function () {
    [, depositor] = await ethers.getSigners();
    ({ spokePool, erc20, destErc20, weth, deploymentBlock } = await deploySpokePoolWithToken(originChainId));
    await enableRoutes(spokePool, [{ originToken: erc20.address, destinationChainId: destinationChainId2 }]);
    spokePoolClient = new SpokePoolClient(createSpyLogger().spyLogger, spokePool, null, originChainId, deploymentBlock);

    await setupTokensForWallet(spokePool, depositor, [erc20, destErc20], weth, 10);
  });

  it("Fetches speedup data associated with a deposit", async function () {
    const deposit = await simpleDeposit(spokePool, erc20, depositor, depositor, destinationChainId);

    await spokePoolClient.update();

    // Before speedup should return the normal deposit object.
    expect(spokePoolClient.appendMaxSpeedUpSignatureToDeposit(deposit as DepositWithBlock)).to.deep.equal(deposit);

    const newRelayFeePct = toBNWei(0.1337);
    const speedUpSignature = await signForSpeedUp(depositor, deposit as DepositWithBlock, newRelayFeePct);
    await spokePool.speedUpDeposit(depositor.address, newRelayFeePct, deposit.depositId, speedUpSignature);
    await spokePoolClient.update();

    // After speedup should return the appended object with the new fee information and signature.
    const expectedDepositData = { ...deposit, speedUpSignature, newRelayerFeePct: newRelayFeePct };
    expect(
      deepEqualsWithBigNumber(
        spokePoolClient.appendMaxSpeedUpSignatureToDeposit(deposit as DepositWithBlock),
        expectedDepositData
      )
    ).to.be.true;

    // Fetching deposits for the depositor should contain the correct fees.
    expect(
      deepEqualsWithBigNumber(
        spokePoolClient.getDepositsForDestinationChain(destinationChainId)[0],
        expectedDepositData,
        ["blockNumber", "logIndex", "quoteBlockNumber", "transactionHash", "transactionIndex"]
      )
    ).to.be.true;
    expect(spokePoolClient.getDepositsForDestinationChain(destinationChainId).length).to.equal(1);
  });

  it("Fetches speedup data associated with an early deposit", async function () {
    const delta = await spokePool.depositQuoteTimeBuffer();
    const now = Number(await spokePool.getCurrentTime());

    await spokePool.setCurrentTime(now + delta);
    const deposit = await simpleDeposit(spokePool, erc20, depositor, depositor, destinationChainId);

    await spokePool.setCurrentTime(now);
    await spokePoolClient.update();

    // Before speedup should return the normal deposit object.
    expect(spokePoolClient.appendMaxSpeedUpSignatureToDeposit(deposit as DepositWithBlock)).to.deep.equal(deposit);

    const newRelayFeePct = toBNWei(0.1337);
    const speedUpSignature = await signForSpeedUp(depositor, deposit as DepositWithBlock, newRelayFeePct);
    await spokePool.speedUpDeposit(depositor.address, newRelayFeePct, deposit.depositId, speedUpSignature);
    await spokePoolClient.update();

    // Deposit is not returned until we reach deposit.quoteTimestamp.
    expect(spokePoolClient.getDepositsForDestinationChain(destinationChainId).length).to.equal(0);
    await spokePool.setCurrentTime(deposit.quoteTimestamp);
    await spokePoolClient.update();

    // After speedup should return the appended object with the new fee information and signature.
    const expectedDepositData = { ...deposit, speedUpSignature, newRelayerFeePct: newRelayFeePct };
    expect(
      deepEqualsWithBigNumber(
        spokePoolClient.appendMaxSpeedUpSignatureToDeposit(deposit as DepositWithBlock),
        expectedDepositData
      )
    ).to.be.true;
    // Fetching deposits for the depositor should contain the correct fees.
    expect(spokePoolClient.getDepositsForDestinationChain(destinationChainId).length).to.equal(1);
    expect(
      deepEqualsWithBigNumber(
        spokePoolClient.getDepositsForDestinationChain(destinationChainId)[0],
        expectedDepositData
      )
    ).to.be.true;
  });

  it("Selects the highest speedup option when multiple are presented", async function () {
    const deposit = await simpleDeposit(spokePool, erc20, depositor, depositor, destinationChainId);

    // Speedup below the original fee should not update to use the new fee.
    const newLowerRelayFeePct = depositRelayerFeePct.sub(toBNWei(0.01));
    const speedUpSignature = await signForSpeedUp(depositor, deposit as DepositWithBlock, newLowerRelayFeePct);
    await spokePool.speedUpDeposit(depositor.address, newLowerRelayFeePct, deposit.depositId, speedUpSignature);
    await spokePoolClient.update();
    // below the original fee should equal the original deposit with no signature.
    expect(
      deepEqualsWithBigNumber(spokePoolClient.appendMaxSpeedUpSignatureToDeposit(deposit as DepositWithBlock), deposit)
    ).to.be.true;
    expect(
      deepEqualsWithBigNumber(spokePoolClient.getDepositsForDestinationChain(destinationChainId)[0], deposit, [
        "quoteBlockNumber",
        "logIndex",
        "blockNumber",
        "transactionHash",
        "transactionIndex",
      ])
    ).to.be.true;
    expect(spokePoolClient.getDepositsForDestinationChain(destinationChainId).length).to.equal(1);
    expect(spokePoolClient.getDeposits()[0].speedUpSignature).to.deep.equal(undefined);

    // SpeedUp the deposit twice. Ensure the highest fee (and signature) is used.

    const speedupFast = toBNWei(0.1337);
    const speedUpFastSignature = await signForSpeedUp(depositor, deposit as DepositWithBlock, speedupFast);
    await spokePool.speedUpDeposit(depositor.address, speedupFast, deposit.depositId, speedUpFastSignature);
    const speedupFaster = toBNWei(0.1338);
    const speedUpFasterSignature = await signForSpeedUp(depositor, deposit as DepositWithBlock, speedupFaster);
    await spokePool.speedUpDeposit(depositor.address, speedupFaster, deposit.depositId, speedUpFasterSignature);
    await spokePoolClient.update();

    // Should use the faster data between the two speedups.
    const expectedDepositData = {
      ...deposit,
      speedUpSignature: speedUpFasterSignature,
      newRelayerFeePct: speedupFaster,
    };
    expect(
      deepEqualsWithBigNumber(
        spokePoolClient.appendMaxSpeedUpSignatureToDeposit(deposit as DepositWithBlock),
        expectedDepositData
      )
    ).to.be.true;
    expect(
      deepEqualsWithBigNumber(
        spokePoolClient.getDepositsForDestinationChain(destinationChainId)[0],
        expectedDepositData,
        ["quoteBlockNumber", "logIndex", "blockNumber", "transactionHash", "transactionIndex"]
      )
    ).to.be.true;
    expect(spokePoolClient.getDepositsForDestinationChain(destinationChainId).length).to.equal(1);
  });
  it("Receives a speed up for a correct depositor but invalid deposit Id", async function () {
    const deposit = await simpleDeposit(spokePool, erc20, depositor, depositor, destinationChainId);

    await spokePoolClient.update();

    // change deposit ID to some invalid value
    deposit.depositId = 1337;

    const newRelayFeePct = toBNWei(0.1337);
    const speedUpSignature = await signForSpeedUp(depositor, deposit as DepositWithBlock, newRelayFeePct);
    await spokePool.speedUpDeposit(depositor.address, newRelayFeePct, deposit.depositId, speedUpSignature);

    let success = false;
    try {
      await spokePoolClient.update();
      success = true;
    } catch {
      // no-op
    }

    expect(success).to.be.true;
  });
});
