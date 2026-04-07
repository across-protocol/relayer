import { expect } from "./utils";
import { parseJson } from "../src/utils";

describe("parseJson", function () {
  describe("stringArray", function () {
    it("parses a valid string array", function () {
      expect(parseJson.stringArray('["a", "b", "c"]')).to.deep.equal(["a", "b", "c"]);
    });

    it("returns empty array for undefined input", function () {
      expect(parseJson.stringArray(undefined)).to.deep.equal([]);
    });

    it("uses custom fallback", function () {
      expect(parseJson.stringArray(undefined, '["x"]')).to.deep.equal(["x"]);
    });

    it("throws on number array", function () {
      expect(() => parseJson.stringArray("[1, 2]")).to.throw();
    });

    it("throws on object input", function () {
      expect(() => parseJson.stringArray('{"a": 1}')).to.throw();
    });

    it("throws on mixed array", function () {
      expect(() => parseJson.stringArray('["a", 1]')).to.throw();
    });
  });

  describe("numberArray", function () {
    it("parses a valid number array", function () {
      expect(parseJson.numberArray("[1, 2, 3]")).to.deep.equal([1, 2, 3]);
    });

    it("returns empty array for undefined input", function () {
      expect(parseJson.numberArray(undefined)).to.deep.equal([]);
    });

    it("throws on string array", function () {
      expect(() => parseJson.numberArray('["a"]')).to.throw();
    });
  });

  describe("stringMap", function () {
    it("parses a valid string map", function () {
      expect(parseJson.stringMap('{"a": "1", "b": "2"}')).to.deep.equal({ a: "1", b: "2" });
    });

    it("returns empty object for undefined input", function () {
      expect(parseJson.stringMap(undefined)).to.deep.equal({});
    });

    it("throws on numeric values", function () {
      expect(() => parseJson.stringMap('{"a": 1}')).to.throw();
    });

    it("throws on non-string values in array input", function () {
      expect(() => parseJson.stringMap("[1]")).to.throw();
    });
  });

  describe("numberMap", function () {
    it("parses a valid number map", function () {
      expect(parseJson.numberMap('{"a": 1, "b": 2}')).to.deep.equal({ a: 1, b: 2 });
    });

    it("returns empty object for undefined input", function () {
      expect(parseJson.numberMap(undefined)).to.deep.equal({});
    });

    it("throws on string values", function () {
      expect(() => parseJson.numberMap('{"a": "1"}')).to.throw();
    });
  });

  describe("stringArrayMap", function () {
    it("parses a valid string array map", function () {
      expect(parseJson.stringArrayMap('{"a": ["x", "y"], "b": ["z"]}')).to.deep.equal({
        a: ["x", "y"],
        b: ["z"],
      });
    });

    it("returns empty object for undefined input", function () {
      expect(parseJson.stringArrayMap(undefined)).to.deep.equal({});
    });

    it("throws on non-array values", function () {
      expect(() => parseJson.stringArrayMap('{"a": "x"}')).to.throw();
    });

    it("throws on number array values", function () {
      expect(() => parseJson.stringArrayMap('{"a": [1, 2]}')).to.throw();
    });
  });
});
