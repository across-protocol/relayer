import { expect } from "./utils";
import "../src/utils"; // Triggers side-effect import of extensions.

describe("Global prototype extensions", function () {
  describe("Set.prototype.toJSON", function () {
    it("serializes an empty Set as an empty array", function () {
      expect(JSON.stringify(new Set())).to.equal("[]");
    });

    it("serializes a Set as an array of its values", function () {
      const result = JSON.parse(JSON.stringify(new Set(["a", "b", "c"])));
      expect(result).to.deep.equal(["a", "b", "c"]);
    });

    it("serializes a Set nested in an object", function () {
      const obj = { addresses: new Set(["0xabc", "0xdef"]) };
      const result = JSON.parse(JSON.stringify(obj));
      expect(result).to.deep.equal({ addresses: ["0xabc", "0xdef"] });
    });
  });

  describe("BigInt.prototype.toJSON", function () {
    it("serializes a BigInt as a string", function () {
      expect(JSON.stringify(BigInt(42))).to.equal('"42"');
    });

    it("serializes a BigInt nested in an object", function () {
      const obj = { amount: BigInt("1000000000000000000") };
      const result = JSON.parse(JSON.stringify(obj));
      expect(result).to.deep.equal({ amount: "1000000000000000000" });
    });
  });
});
