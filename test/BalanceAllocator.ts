import { BalanceAllocator, BalanceMap } from "../src/clients/BalanceAllocator";
import { BigNumber, toAddressType, Address } from "../src/utils";
import { randomAddress, chai } from "./utils";
const { expect } = chai;

class TestBalanceAllocator extends BalanceAllocator {
  constructor() {
    super({});
  }

  mockBalances: BalanceMap = {};
  setMockBalances(chainId: number, token: Address, holder: Address, balance?: BigNumber) {
    // Note: cannot use assign because it breaks the BigNumber object.
    if (!this.mockBalances[chainId]) {
      this.mockBalances[chainId] = {};
    }
    if (!this.mockBalances[chainId][token.toBytes32()]) {
      this.mockBalances[chainId][token.toBytes32()] = {};
    }
    if (!balance) {
      delete this.mockBalances[chainId][token.toBytes32()][holder.toBytes32()];
    } else {
      this.mockBalances[chainId][token.toBytes32()][holder.toBytes32()] = balance;
    }
  }

  protected _queryBalance(chainId: number, token: Address, holder: Address): Promise<BigNumber> {
    if (!this.mockBalances[chainId]?.[token.toBytes32()]?.[holder.toBytes32()]) {
      throw new Error("No balance!");
    }
    return Promise.resolve(this.mockBalances[chainId][token.toBytes32()][holder.toBytes32()]);
  }
}

describe("BalanceAllocator", async function () {
  let balanceAllocator: TestBalanceAllocator;
  const testToken1 = toAddressType(randomAddress(), 1);
  const testToken2 = toAddressType(randomAddress(), 1);

  const testAccount1 = toAddressType(randomAddress(), 1);

  beforeEach(async function () {
    balanceAllocator = new TestBalanceAllocator();
  });

  it("Correct initial state", async function () {
    balanceAllocator.setMockBalances(1, testToken1, testAccount1, BigNumber.from(100));
    expect(await balanceAllocator.getBalance(1, testToken1, testAccount1)).to.equal(BigNumber.from(100));
    expect(balanceAllocator.getUsed(1, testToken1, testAccount1)).to.equal(BigNumber.from(0));
  });

  it("Add used", async function () {
    balanceAllocator.addUsed(1, testToken1, testAccount1, BigNumber.from(100));
    expect(balanceAllocator.getUsed(1, testToken1, testAccount1)).to.equal(BigNumber.from(100));
  });

  it("Returns balance sub used", async function () {
    balanceAllocator.addUsed(1, testToken1, testAccount1, BigNumber.from(100));
    balanceAllocator.setMockBalances(1, testToken1, testAccount1, BigNumber.from(150));
    expect(await balanceAllocator.getBalanceSubUsed(1, testToken1, testAccount1)).to.equal(BigNumber.from(50));
  });

  it("Simple request", async function () {
    balanceAllocator.setMockBalances(1, testToken1, testAccount1, BigNumber.from(100));
    expect(await balanceAllocator.requestBalanceAllocation(1, [testToken1], testAccount1, BigNumber.from(50))).to.be
      .true;
    expect(balanceAllocator.getUsed(1, testToken1, testAccount1)).to.equal(BigNumber.from(50));
  });

  it("Multiple requests, multiple tokens, succeeds", async function () {
    balanceAllocator.setMockBalances(1, testToken1, testAccount1, BigNumber.from(100));
    balanceAllocator.setMockBalances(1, testToken2, testAccount1, BigNumber.from(100));
    expect(
      await balanceAllocator.requestBalanceAllocations([
        { chainId: 1, tokens: [testToken1], holder: testAccount1, amount: BigNumber.from(50) },
        { chainId: 1, tokens: [testToken2], holder: testAccount1, amount: BigNumber.from(50) },
      ])
    ).to.be.true;
    expect(balanceAllocator.getUsed(1, testToken1, testAccount1)).to.equal(BigNumber.from(50));
    expect(balanceAllocator.getUsed(1, testToken2, testAccount1)).to.equal(BigNumber.from(50));
  });

  it("Combined request, same token, succeeds", async function () {
    balanceAllocator.setMockBalances(1, testToken1, testAccount1, BigNumber.from(100));
    expect(
      await balanceAllocator.requestBalanceAllocations([
        { chainId: 1, tokens: [testToken1], holder: testAccount1, amount: BigNumber.from(50) },
        { chainId: 1, tokens: [testToken1], holder: testAccount1, amount: BigNumber.from(50) },
      ])
    ).to.be.true;
    expect(balanceAllocator.getUsed(1, testToken1, testAccount1)).to.equal(BigNumber.from(100));
  });

  it("Combined request, same token, fails", async function () {
    balanceAllocator.setMockBalances(1, testToken1, testAccount1, BigNumber.from(99));
    expect(
      await balanceAllocator.requestBalanceAllocations([
        { chainId: 1, tokens: [testToken1], holder: testAccount1, amount: BigNumber.from(50) },
        { chainId: 1, tokens: [testToken1], holder: testAccount1, amount: BigNumber.from(50) },
      ])
    ).to.be.false;
    expect(balanceAllocator.getUsed(1, testToken1, testAccount1)).to.equal(BigNumber.from(0));
  });

  it("Combined request, multiple tokens per request, succeeds", async function () {
    balanceAllocator.setMockBalances(1, testToken1, testAccount1, BigNumber.from(99));
    balanceAllocator.setMockBalances(1, testToken2, testAccount1, BigNumber.from(99));
    expect(
      await balanceAllocator.requestBalanceAllocations([
        { chainId: 1, tokens: [testToken1, testToken2], holder: testAccount1, amount: BigNumber.from(50) },
        { chainId: 1, tokens: [testToken1, testToken2], holder: testAccount1, amount: BigNumber.from(50) },
      ])
    ).to.be.true;
    expect(balanceAllocator.getUsed(1, testToken1, testAccount1)).to.equal(BigNumber.from(99));
    expect(balanceAllocator.getUsed(1, testToken2, testAccount1)).to.equal(BigNumber.from(1));
  });
});
