import { depositRelayerFeePct, destinationChainId, modifyRelayHelper } from "./constants";
import {
  Contract,
  SignerWithAddress,
  createSpyLogger,
  deepEqualsWithBigNumber,
  deploySpokePoolWithToken,
  enableRoutes,
  ethers,
  expect,
  originChainId,
  setupTokensForWallet,
  simpleDeposit,
  toBNWei,
} from "./utils";

import { SpokePoolClient } from "../src/clients";
import { DepositWithBlock } from "../src/interfaces";

let spokePool: Contract, erc20: Contract, destErc20: Contract, weth: Contract;
let depositor: SignerWithAddress, deploymentBlock: number;
const destinationChainId2 = destinationChainId + 1;

let spokePoolClient: SpokePoolClient;

describe("SpokePoolClient: SpeedUp", function () {
  const ignoredFields = [
    "blockNumber",
    "blockTimestamp",
    "logIndex",
    "quoteBlockNumber",
    "transactionHash",
    "transactionIndex",
  ];

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
    const speedUpSignature = await modifyRelayHelper(
      newRelayFeePct,
      deposit.depositId.toString(),
      deposit.originChainId.toString(),
      depositor,
      deposit.recipient,
      "0x"
    );
    await spokePool.speedUpDeposit(
      depositor.address,
      newRelayFeePct,
      deposit.depositId,
      deposit.recipient,
      "0x",
      speedUpSignature.signature
    );
    await spokePoolClient.update();

    // After speedup should return the appended object with the new fee information and signature.
    const expectedDepositData = {
      ...deposit,
      speedUpSignature: speedUpSignature.signature,
      newRelayerFeePct: newRelayFeePct,
      updatedMessage: "0x",
      updatedRecipient: deposit.recipient,
    };
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
        ignoredFields
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
    const speedUpSignature = await modifyRelayHelper(
      newRelayFeePct,
      deposit.depositId.toString(),
      deposit.originChainId.toString(),
      depositor,
      deposit.recipient,
      "0x"
    );
    await spokePool.speedUpDeposit(
      depositor.address,
      newRelayFeePct,
      deposit.depositId,
      deposit.recipient,
      "0x",
      speedUpSignature.signature
    );
    await spokePoolClient.update();

    // Deposit is not returned until we reach deposit.quoteTimestamp.
    expect(spokePoolClient.getDepositsForDestinationChain(destinationChainId).length).to.equal(0);
    await spokePool.setCurrentTime(deposit.quoteTimestamp);
    await spokePoolClient.update();

    // After speedup should return the appended object with the new fee information and signature.
    const expectedDepositData = {
      ...deposit,
      speedUpSignature: speedUpSignature.signature,
      newRelayerFeePct: newRelayFeePct,
      updatedMessage: "0x",
      updatedRecipient: deposit.recipient,
    };
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
        expectedDepositData,
        ignoredFields
      )
    ).to.be.true;
  });

  it("Selects the highest speedup option when multiple are presented", async function () {
    const deposit = await simpleDeposit(spokePool, erc20, depositor, depositor, destinationChainId);

    // Speedup below the original fee should not update to use the new fee.
    const newLowerRelayFeePct = depositRelayerFeePct.sub(toBNWei(0.01));
    const speedUpSignature = await modifyRelayHelper(
      newLowerRelayFeePct,
      deposit.depositId.toString(),
      deposit.originChainId.toString(),
      depositor,
      deposit.recipient,
      "0x"
    );
    await spokePool.speedUpDeposit(
      depositor.address,
      newLowerRelayFeePct,
      deposit.depositId,
      deposit.recipient,
      "0x",
      speedUpSignature.signature
    );
    await spokePoolClient.update();
    // below the original fee should equal the original deposit with no signature.
    expect(
      deepEqualsWithBigNumber(spokePoolClient.appendMaxSpeedUpSignatureToDeposit(deposit as DepositWithBlock), deposit)
    ).to.be.true;
    expect(
      deepEqualsWithBigNumber(
        spokePoolClient.getDepositsForDestinationChain(destinationChainId)[0],
        deposit,
        ignoredFields
      )
    ).to.be.true;
    expect(spokePoolClient.getDepositsForDestinationChain(destinationChainId).length).to.equal(1);
    expect(spokePoolClient.getDeposits()[0].speedUpSignature).to.deep.equal(undefined);

    // SpeedUp the deposit twice. Ensure the highest fee (and signature) is used.

    const speedupFast = toBNWei(0.1337);
    const speedUpFastSignature = await modifyRelayHelper(
      speedupFast,
      deposit.depositId.toString(),
      deposit.originChainId.toString(),
      depositor,
      deposit.recipient,
      "0x"
    );
    await spokePool.speedUpDeposit(
      depositor.address,
      speedupFast,
      deposit.depositId,
      deposit.recipient,
      "0x",
      speedUpFastSignature.signature
    );
    const speedupFaster = toBNWei(0.1338);
    const speedUpFasterSignature = await modifyRelayHelper(
      speedupFaster,
      deposit.depositId.toString(),
      deposit.originChainId.toString(),
      depositor,
      deposit.recipient,
      "0x"
    );
    await spokePool.speedUpDeposit(
      depositor.address,
      speedupFaster,
      deposit.depositId,
      deposit.recipient,
      "0x",
      speedUpFasterSignature.signature
    );
    await spokePoolClient.update();

    // Should use the faster data between the two speedups.
    const expectedDepositData = {
      ...deposit,
      speedUpSignature: speedUpFasterSignature.signature,
      newRelayerFeePct: speedupFaster,
      updatedMessage: "0x",
      updatedRecipient: deposit.recipient,
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
        ignoredFields
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
    const speedUpSignature = await modifyRelayHelper(
      newRelayFeePct,
      deposit.depositId.toString(),
      deposit.originChainId.toString(),
      depositor,
      deposit.recipient,
      "0x"
    );
    await spokePool.speedUpDeposit(
      depositor.address,
      newRelayFeePct,
      deposit.depositId,
      deposit.recipient,
      "0x",
      speedUpSignature.signature
    );

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
