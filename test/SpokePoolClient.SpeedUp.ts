import { expect, ethers, Contract, SignerWithAddress, setupTokensForWallet, signForSpeedUp, toBNWei } from "./utils";
import { deploySpokePoolWithToken, enableRoutes, simpleDeposit, originChainId, createSpyLogger } from "./utils";
import { depositRelayerFeePct, destinationChainId } from "./constants";

import { SpokePoolClient } from "../src/clients";
import { getUnfilledDeposits } from "../src/utils";

let spokePool: Contract, erc20: Contract, destErc20: Contract, weth: Contract;
let owner: SignerWithAddress, depositor: SignerWithAddress;
const destinationChainId2 = destinationChainId + 1;

let spokePoolClient: SpokePoolClient;

describe("SpokePoolClient: SpeedUp", async function () {
  beforeEach(async function () {
    [owner, depositor] = await ethers.getSigners();
    ({ spokePool, erc20, destErc20, weth } = await deploySpokePoolWithToken(originChainId));
    await enableRoutes(spokePool, [{ originToken: erc20.address, destinationChainId: destinationChainId2 }]);
    spokePoolClient = new SpokePoolClient(createSpyLogger().spyLogger, spokePool, null, originChainId);

    await setupTokensForWallet(spokePool, depositor, [erc20, destErc20], weth, 10);
  });

  it("Fetches speedup data associated with a deposit", async function () {
    const deposit = await simpleDeposit(spokePool, erc20, depositor, depositor, destinationChainId);

    await spokePoolClient.update();

    // Before speedup should return the normal deposit object.
    expect(spokePoolClient.appendMaxSpeedUpSignatureToDeposit(deposit)).to.deep.equal(deposit);

    const newRelayFeePct = toBNWei(0.1337);
    const speedUpSignature = await signForSpeedUp(depositor, deposit, newRelayFeePct);
    await spokePool.speedUpDeposit(depositor.address, newRelayFeePct, deposit.depositId, speedUpSignature);
    await spokePoolClient.update();

    // After speedup should return the appended object with the new fee information and signature.
    const expectedDepositData = { ...deposit, speedUpSignature, newRelayerFeePct: newRelayFeePct };
    expect(spokePoolClient.appendMaxSpeedUpSignatureToDeposit(deposit)).to.deep.equal(expectedDepositData);

    // Fetching deposits for the depositor should contain the correct fees.
    expect(spokePoolClient.getDepositsForDestinationChain(destinationChainId)).to.deep.equal([expectedDepositData]);
    expect(spokePoolClient.getDeposits().filter((deposit) => deposit.depositor === depositor.address)).to.deep.equal([
      expectedDepositData,
    ]);
  });
  it("Selects the highest speedup option when multiple are presented", async function () {
    const deposit = await simpleDeposit(spokePool, erc20, depositor, depositor, destinationChainId);

    // Speedup below the original fee should not update to use the new fee.
    const newLowerRelayFeePct = depositRelayerFeePct.sub(toBNWei(0.01));
    const speedUpSignature = await signForSpeedUp(depositor, deposit, newLowerRelayFeePct);
    await spokePool.speedUpDeposit(depositor.address, newLowerRelayFeePct, deposit.depositId, speedUpSignature);
    await spokePoolClient.update();
    // below the original fee should equal the original deposit with no signature.
    expect(spokePoolClient.appendMaxSpeedUpSignatureToDeposit(deposit)).to.deep.equal(deposit);
    expect(spokePoolClient.getDepositsForDestinationChain(destinationChainId)).to.deep.equal([deposit]);
    expect(spokePoolClient.getDeposits().filter((deposit) => deposit.depositor === depositor.address)).to.deep.equal([
      deposit,
    ]);
    expect(
      spokePoolClient.getDeposits().filter((deposit) => deposit.depositor === depositor.address)[0].speedUpSignature
    ).to.deep.equal(undefined);

    // SpeedUp the deposit twice. Ensure the highest fee (and signature) is used.

    const speedupFast = toBNWei(0.1337);
    const speedUpFastSignature = await signForSpeedUp(depositor, deposit, speedupFast);
    await spokePool.speedUpDeposit(depositor.address, speedupFast, deposit.depositId, speedUpFastSignature);
    const speedupFaster = toBNWei(0.1338);
    const speedUpFasterSignature = await signForSpeedUp(depositor, deposit, speedupFaster);
    await spokePool.speedUpDeposit(depositor.address, speedupFaster, deposit.depositId, speedUpFasterSignature);
    await spokePoolClient.update();

    // Should use the faster data between the two speedups.
    const expectedDepositData = {
      ...deposit,
      speedUpSignature: speedUpFasterSignature,
      newRelayerFeePct: speedupFaster,
    };
    expect(spokePoolClient.appendMaxSpeedUpSignatureToDeposit(deposit)).to.deep.equal(expectedDepositData);
    expect(spokePoolClient.getDepositsForDestinationChain(destinationChainId)).to.deep.equal([expectedDepositData]);
    expect(spokePoolClient.getDeposits().filter((deposit) => deposit.depositor === depositor.address)).to.deep.equal([
      expectedDepositData,
    ]);
  });
  it("Receives a speed up for a correct depositor but invalid deposit Id", async function () {
    const deposit = await simpleDeposit(spokePool, erc20, depositor, depositor, destinationChainId);

    await spokePoolClient.update();

    // change deposit ID to some invalid value
    deposit.depositId = 1337;

    const newRelayFeePct = toBNWei(0.1337);
    const speedUpSignature = await signForSpeedUp(depositor, deposit, newRelayFeePct);
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
