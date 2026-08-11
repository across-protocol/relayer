import { RedisCache } from "../src/cache/Redis";
import { expect, sinon } from "./utils";

describe("RedisCache", function () {
  function makeTransaction() {
    const transaction = {
      set: sinon.stub(),
      sAdd: sinon.stub(),
      sRem: sinon.stub(),
      exec: sinon.stub().resolves(["OK", 1]),
    };
    transaction.set.returns(transaction);
    transaction.sAdd.returns(transaction);
    transaction.sRem.returns(transaction);
    return transaction;
  }

  it("sets order details and status membership in one transaction", async function () {
    const transaction = makeTransaction();
    const multi = sinon.stub().returns(transaction);
    const cache = new RedisCache({ multi } as never, "test");

    await cache.setAndAddToSet("order", "details", "status", "cloid", 60);
    expect(multi.calledOnce).to.equal(true);
    expect(transaction.set.calledOnceWith("test:order", "details", { expiration: { type: "EX", value: 60 } })).to.equal(
      true
    );
    expect(transaction.sAdd.calledOnceWith("test:status", "cloid")).to.equal(true);
    expect(transaction.exec.calledOnce).to.equal(true);
  });

  it("moves a set member between sets in one transaction", async function () {
    const transaction = makeTransaction();
    const multi = sinon.stub().returns(transaction);
    const cache = new RedisCache({ multi } as never, "test");

    await cache.moveSetMember("old-status", "new-status", "cloid");
    expect(multi.calledOnce).to.equal(true);
    expect(transaction.sAdd.calledOnceWith("test:new-status", "cloid")).to.equal(true);
    expect(transaction.sRem.calledOnceWith("test:old-status", "cloid")).to.equal(true);
    expect(transaction.exec.calledOnce).to.equal(true);
  });
});
