// Global prototype extensions for JSON serialization.
//
// Set.prototype.toJSON: Reinstates behavior previously provided as a
// side-effect of the core-js polyfills bundled in @pinata/sdk (removed with
// the IPFS utils in SDK 4.3.139). Without this, JSON.stringify(set) produces
// "{}" instead of an array.
//
// BigInt.prototype.toJSON: Permits BigInt values to be serialized as strings
// by JSON.stringify, which otherwise throws "BigInt value can't be serialized".
export {};

declare global {
  interface Set<T> {
    toJSON(): T[];
  }
  interface BigInt {
    toJSON(): string;
  }
}

Set.prototype.toJSON = function () {
  return Array.from(this);
};

BigInt.prototype.toJSON = function () {
  return this.toString();
};
