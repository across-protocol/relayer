import { ethers } from "hardhat";
import { expect } from "chai";
import { Contract } from "ethers";
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers";

const encodeIntent = (params: {
  version?: number;
  recipient: string;
  solver: string;
  outcomeToken: string;
  tokenId: number;
  outcomeAmount: number;
  limitPrice?: string;
  clientOrderId?: string;
}): string => {
  const {
    version = 1,
    recipient,
    solver,
    outcomeToken,
    tokenId,
    outcomeAmount,
    limitPrice = "0",
    clientOrderId = ethers.constants.HashZero,
  } = params;
  return ethers.utils.defaultAbiCoder.encode(
    ["tuple(uint8 version,address recipient,address solver,address outcomeToken,uint256 tokenId,uint256 outcomeAmount,uint256 limitPrice,bytes32 clientOrderId)"],
    [
      {
        version,
        recipient,
        solver,
        outcomeToken,
        tokenId,
        outcomeAmount,
        limitPrice,
        clientOrderId,
      },
    ]
  );
};

describe("PolymarketHandler", function () {
  let owner: SignerWithAddress;
  let spokePool: SignerWithAddress;
  let solver: SignerWithAddress;
  let user: SignerWithAddress;
  let handler: Contract;
  let usdc: Contract;
  let outcome: Contract;

  const tokenId = 1;
  const outcomeAmount = 10;
  const paymentAmount = ethers.utils.parseUnits("100", 6);

  beforeEach(async function () {
    [owner, spokePool, solver, user] = await ethers.getSigners();

    const MockERC20 = await ethers.getContractFactory("MockERC20");
    usdc = await MockERC20.deploy("USD Coin", "USDC", 6);

    const MockERC1155 = await ethers.getContractFactory("MockERC1155");
    outcome = await MockERC1155.deploy();

    const Handler = await ethers.getContractFactory("PolymarketHandler");
    handler = await Handler.deploy(spokePool.address, usdc.address, owner.address);

    await handler.connect(owner).setSolverAllowed(solver.address, true);
    await outcome.connect(solver).setApprovalForAll(handler.address, true);
    await outcome.mint(solver.address, tokenId, outcomeAmount);
    await usdc.mint(handler.address, paymentAmount);
  });

  it("transfers outcome tokens to user and USDC to solver", async function () {
    const message = encodeIntent({
      recipient: user.address,
      solver: solver.address,
      outcomeToken: outcome.address,
      tokenId,
      outcomeAmount,
      limitPrice: "530000",
      clientOrderId: ethers.utils.formatBytes32String("order-1"),
    });

    await expect(
      handler.connect(spokePool).handleV3AcrossMessage(usdc.address, paymentAmount, solver.address, message)
    )
      .to.emit(handler, "PolymarketFill")
      .withArgs(
        solver.address,
        solver.address,
        user.address,
        outcome.address,
        tokenId,
        outcomeAmount,
        usdc.address,
        paymentAmount,
        ethers.utils.formatBytes32String("order-1")
      );

    expect(await outcome.balanceOf(user.address, tokenId)).to.equal(outcomeAmount);
    expect(await usdc.balanceOf(solver.address)).to.equal(paymentAmount);
  });

  it("reverts when called by non-spokePool", async function () {
    const message = encodeIntent({
      recipient: user.address,
      solver: solver.address,
      outcomeToken: outcome.address,
      tokenId,
      outcomeAmount,
    });

    await expect(
      handler.connect(user).handleV3AcrossMessage(usdc.address, paymentAmount, solver.address, message)
    ).to.be.revertedWithCustomError(handler, "NotSpokePool");
  });

  it("reverts when solver not allowed", async function () {
    await handler.connect(owner).setSolverAllowed(solver.address, false);
    const message = encodeIntent({
      recipient: user.address,
      solver: solver.address,
      outcomeToken: outcome.address,
      tokenId,
      outcomeAmount,
    });

    await expect(
      handler.connect(spokePool).handleV3AcrossMessage(usdc.address, paymentAmount, solver.address, message)
    ).to.be.revertedWithCustomError(handler, "RelayerNotAllowed");
  });

  it("reverts when payment token does not match", async function () {
    const MockERC20 = await ethers.getContractFactory("MockERC20");
    const badToken = await MockERC20.deploy("Bad", "BAD", 6);
    const message = encodeIntent({
      recipient: user.address,
      solver: solver.address,
      outcomeToken: outcome.address,
      tokenId,
      outcomeAmount,
    });

    await expect(
      handler.connect(spokePool).handleV3AcrossMessage(badToken.address, paymentAmount, solver.address, message)
    ).to.be.revertedWithCustomError(handler, "TokenNotAllowed");
  });

  it("reverts when relayer does not match solver", async function () {
    await handler.connect(owner).setSolverAllowed(user.address, true);
    const message = encodeIntent({
      recipient: user.address,
      solver: solver.address,
      outcomeToken: outcome.address,
      tokenId,
      outcomeAmount,
    });

    await expect(
      handler.connect(spokePool).handleV3AcrossMessage(usdc.address, paymentAmount, user.address, message)
    ).to.be.revertedWithCustomError(handler, "RelayerMismatch");
  });

  it("reverts when solver has not approved ERC1155 transfer", async function () {
    await outcome.connect(solver).setApprovalForAll(handler.address, false);
    const message = encodeIntent({
      recipient: user.address,
      solver: solver.address,
      outcomeToken: outcome.address,
      tokenId,
      outcomeAmount,
    });

    await expect(
      handler.connect(spokePool).handleV3AcrossMessage(usdc.address, paymentAmount, solver.address, message)
    ).to.be.reverted;
  });
});
