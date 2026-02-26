import { ExcessOrDeficit, sortDeficitFunction, sortExcessFunction } from "../src/rebalancer/rebalancer";
import { BigNumber, expect } from "./utils";

describe("RebalancerClient.utils", () => {
  const decimalsByToken: Record<string, number> = {
    token6: 6,
    token18: 18,
    token8: 8,
    tokenA: 18,
    tokenB: 18,
    tokenC: 18,
  };

  function buildEntry(token: string, chainId: number, amount: BigNumber, priorityTier: number): ExcessOrDeficit {
    return { token, chainId, amount, priorityTier };
  }

  const mockTokenInfoResolver = (tokenSymbol: string, chainId: number) => {
    void chainId;
    return {
      address: "0x0000000000000000000000000000000000000000",
      symbol: tokenSymbol,
      decimals: decimalsByToken[tokenSymbol] ?? 18,
    } as unknown as ReturnType<typeof import("../src/utils").getTokenInfoFromSymbol>;
  };

  describe("sortDeficitFunction", () => {
    it("sorts by priority tier from highest to lowest", () => {
      const sorted = [
        buildEntry("tokenA", 1, BigNumber.from("10"), 1),
        buildEntry("tokenB", 1, BigNumber.from("1"), 3),
        buildEntry("tokenC", 1, BigNumber.from("5"), 2),
      ].sort((a, b) => sortDeficitFunction(a, b, mockTokenInfoResolver));

      expect(sorted.map((x) => x.token)).to.deep.equal(["tokenB", "tokenC", "tokenA"]);
    });

    it("sorts same-priority deficits by normalized amount from largest to smallest", () => {
      const sorted = [
        buildEntry("token6", 1, BigNumber.from("2000000"), 2), // 2.0 with 6 decimals
        buildEntry("token18", 1, BigNumber.from("1000000000000000000"), 2), // 1.0 with 18 decimals
      ].sort((a, b) => sortDeficitFunction(a, b, mockTokenInfoResolver));

      expect(sorted.map((x) => x.token)).to.deep.equal(["token6", "token18"]);
    });

    it("returns 0 for equal normalized amounts at same priority", () => {
      const comparison = sortDeficitFunction(
        buildEntry("token6", 1, BigNumber.from("1000000"), 2),
        buildEntry("token18", 1, BigNumber.from("1000000000000000000"), 2),
        mockTokenInfoResolver
      );

      expect(comparison).to.equal(0);
    });
  });

  describe("sortExcessFunction", () => {
    it("sorts by priority tier from lowest to highest", () => {
      const sorted = [
        buildEntry("tokenA", 1, BigNumber.from("10"), 2),
        buildEntry("tokenB", 1, BigNumber.from("1"), 0),
        buildEntry("tokenC", 1, BigNumber.from("5"), 1),
      ].sort((a, b) => sortExcessFunction(a, b, mockTokenInfoResolver));

      expect(sorted.map((x) => x.token)).to.deep.equal(["tokenB", "tokenC", "tokenA"]);
    });

    it("sorts same-priority excesses by normalized amount from largest to smallest", () => {
      const sorted = [
        buildEntry("token18", 1, BigNumber.from("1000000000000000000"), 2), // 1.0 with 18 decimals
        buildEntry("token8", 1, BigNumber.from("200000000"), 2), // 2.0 with 8 decimals
      ].sort((a, b) => sortExcessFunction(a, b, mockTokenInfoResolver));

      expect(sorted.map((x) => x.token)).to.deep.equal(["token8", "token18"]);
    });

    it("returns 0 for equal normalized amounts at same priority", () => {
      const comparison = sortExcessFunction(
        buildEntry("token8", 1, BigNumber.from("100000000"), 2),
        buildEntry("token18", 1, BigNumber.from("1000000000000000000"), 2),
        mockTokenInfoResolver
      );

      expect(comparison).to.equal(0);
    });
  });
});
