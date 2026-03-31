import { AugmentedTransaction } from "../src/clients";
import { applySwapApiCalldataMarkerInPlace, SWAP_API_CALLDATA_MARKER, willSucceed } from "../src/utils";
import { Contract, expect, ethers } from "./utils";

describe("applySwapApiCalldataMarkerInPlace", function () {
  it("appends marker once for raw calldata when flag is set", function () {
    const base = "0xabcd";
    const txn = {
      method: "",
      args: [base],
      swapApiCalldataMarker: true,
    } as AugmentedTransaction;
    applySwapApiCalldataMarkerInPlace(txn);
    expect(txn.args[0]).to.equal(ethers.utils.hexConcat([base, SWAP_API_CALLDATA_MARKER]));
    applySwapApiCalldataMarkerInPlace(txn);
    expect(txn.args[0]).to.equal(ethers.utils.hexConcat([base, SWAP_API_CALLDATA_MARKER]));
  });

  it("encodes structured tx to raw calldata with marker", function () {
    const iface = new ethers.utils.Interface(["function foo(uint256 x) external"]);
    const contract = new ethers.Contract(ethers.constants.AddressZero, iface) as Contract;
    const txn = {
      contract,
      method: "foo",
      args: [42],
      swapApiCalldataMarker: true,
    } as AugmentedTransaction;
    applySwapApiCalldataMarkerInPlace(txn);
    expect(txn.method).to.equal("");
    const encoded = iface.encodeFunctionData("foo", [42]);
    expect(txn.args[0]).to.equal(ethers.utils.hexConcat([encoded, SWAP_API_CALLDATA_MARKER]));
  });

  it("no-ops when flag is unset", function () {
    const data = "0xabcd";
    const txn = { method: "", args: [data] } as AugmentedTransaction;
    applySwapApiCalldataMarkerInPlace(txn);
    expect(txn.args[0]).to.equal(data);
  });
});

describe("willSucceed + swapApiCalldataMarker", function () {
  it("structured tx is encoded to raw with marker before early return when gasLimit set", async function () {
    const iface = new ethers.utils.Interface(["function foo(uint256 x) external"]);
    const contract = {
      address: ethers.constants.AddressZero,
      interface: iface,
      signer: { getAddress: async () => ethers.constants.AddressZero },
      provider: {
        call: async () => "0x",
        estimateGas: async () => ethers.BigNumber.from(21000),
        getNetwork: async () => ({ chainId: 1 }),
      },
    } as unknown as Contract;

    const txn: AugmentedTransaction = {
      contract,
      chainId: 1,
      method: "foo",
      args: [7],
      gasLimit: ethers.BigNumber.from(50_000),
      swapApiCalldataMarker: true,
    };

    await willSucceed(txn);
    expect(txn.method).to.equal("");
    const encoded = iface.encodeFunctionData("foo", [7]);
    expect(txn.args[0]).to.equal(ethers.utils.hexConcat([encoded, SWAP_API_CALLDATA_MARKER]));
  });

  it("mutates args before raw simulation path (smoke: early return when gasLimit set)", async function () {
    const base = "0x01";
    const contract = {
      address: ethers.constants.AddressZero,
      signer: { getAddress: async () => ethers.constants.AddressZero },
      provider: {
        call: async () => "0x",
        estimateGas: async () => ethers.BigNumber.from(21000),
        getNetwork: async () => ({ chainId: 1 }),
      },
    } as unknown as Contract;

    const txn: AugmentedTransaction = {
      contract,
      chainId: 1,
      method: "",
      args: [base],
      gasLimit: ethers.BigNumber.from(50_000),
      swapApiCalldataMarker: true,
    };

    await willSucceed(txn);
    expect(txn.args[0]).to.equal(ethers.utils.hexConcat([base, SWAP_API_CALLDATA_MARKER]));
  });
});
