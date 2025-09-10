import { expect } from "../utils";
import { EvmAddress } from "../../src/utils";
import * as OFT from "../../src/utils/OFTUtils";

describe("Cross Chain Adapter: OFTBridge", function () {
  // protects us from any changes to dependencies of `oftAddressToBytes32` that would silently break (potentially blackhole funds) on OFT sends
  // values taken from real oft send: https://etherscan.io/tx/0xa861d4c752914bf0757045b8d9119a074806bedaf7beb626a4eba2dc2bece5d7
  it("oftAddressToBytes32 produces correct zero-padded bytes32 string to pass into the OFT messenger contract", function () {
    const addr = EvmAddress.from("0x9A8f92a830A5cB89a3816e3D267CB7791c16b04D");
    const actual = OFT.formatToAddress(addr);
    const expected = "0x0000000000000000000000009a8f92a830a5cb89a3816e3d267cb7791c16b04d";
    expect(actual).to.equal(expected);
  });
});
