import { CHAIN_IDs, TOKEN_SYMBOLS_MAP } from "@across-protocol/constants";
import { createSpyLogger, ethers, expect, toBNWei } from "../utils";
import { EvmAddress } from "../../src/utils";
import { OFTBridge } from "../../src/adapter/bridges/OFTBridge";
import * as OFT from "../../src/utils/OFTUtils";

describe("Cross Chain Adapter: OFTBridge", function () {
  describe("reports the destination path's remaining transfer capacity", function () {
    const hubChainId = CHAIN_IDs.MAINNET;
    const l2ChainId = CHAIN_IDs.TRON;
    const l1Token = EvmAddress.from(TOKEN_SYMBOLS_MAP.USDT.addresses[CHAIN_IDs.MAINNET]);
    // Placeholder a vanilla OFT reports when the path enforces no limit.
    const uncapped = ethers.BigNumber.from("0xffffffffffffffff");
    let bridge: OFTBridge;

    // Replaces the l1Bridge contract with a mock quoteOFT reporting `capacity` as maxAmountLD. Legacy-mesh
    // adapters echo the requested amount back as amountSentLD rather than capping it, so the mock does too:
    // maxAmountLD is the only field that reports capacity on every path type.
    const mockBridgeCapacity = (capacity: ReturnType<typeof ethers.BigNumber.from>) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const realBridge = (bridge as any).l1Bridge;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (bridge as any).l1Bridge = {
        address: realBridge.address,
        signer: realBridge.signer,
        quoteOFT: async (sendParam: OFT.SendParamStruct) => [
          { minAmountLD: 0, maxAmountLD: capacity },
          [],
          { amountSentLD: sendParam.amountLD, amountReceivedLD: sendParam.amountLD },
        ],
      };
    };

    beforeEach(async function () {
      const [signer] = await ethers.getSigners();
      bridge = new OFTBridge(l2ChainId, hubChainId, signer, signer, l1Token, createSpyLogger().spyLogger);
    });

    it("reports remaining capacity on a metered path", async function () {
      mockBridgeCapacity(toBNWei("63201.593061", 6));
      expect((await bridge.getMaxL1ToL2TransferAmount())?.toString()).to.equal(toBNWei("63201.593061", 6).toString());
    });

    it("reports no cap when the path is unmetered", async function () {
      mockBridgeCapacity(uncapped);
      expect(await bridge.getMaxL1ToL2TransferAmount()).to.equal(undefined);
    });

    it("reports zero on a drained path so the caller skips rather than sending nothing", async function () {
      mockBridgeCapacity(ethers.BigNumber.from(0));
      expect((await bridge.getMaxL1ToL2TransferAmount())?.toString()).to.equal("0");
    });
  });

  // protects us from any changes to dependencies of `oftAddressToBytes32` that would silently break (potentially blackhole funds) on OFT sends
  // values taken from real oft send: https://etherscan.io/tx/0xa861d4c752914bf0757045b8d9119a074806bedaf7beb626a4eba2dc2bece5d7
  it("oftAddressToBytes32 produces correct zero-padded bytes32 string to pass into the OFT messenger contract", function () {
    const addr = EvmAddress.from("0x9A8f92a830A5cB89a3816e3D267CB7791c16b04D");
    const actual = OFT.formatToAddress(addr);
    const expected = "0x0000000000000000000000009a8f92a830a5cb89a3816e3d267cb7791c16b04d";
    expect(actual).to.equal(expected);
  });
});
