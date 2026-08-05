import { utils as zksUtils } from "zksync-ethers";
import { useLegacyFinalizeWithdrawal } from "../src/finalizer/utils/zkSync";
import { CHAIN_IDs } from "../src/utils";
import { expect } from "./utils";

// zkSync Era's and Lens' L2 USDC bridges are ordinary contracts rather than system contracts, so a USDC
// withdrawal's l2Sender is neither the asset router nor the base token.
const LENS_L2_USDC_BRIDGE = "0x7188b6975eec82ae914b6ec7ac32b3c9a18b2c81";

describe("ZkSyncFinalizer", function () {
  describe("useLegacyFinalizeWithdrawal", function () {
    // Each row was verified by simulating both entrypoints against mainnet state on 2026-08-05.
    const cases: { name: string; l2ChainId: number; l2Sender: string; legacy: boolean }[] = [
      {
        name: "zkSync ETH withdrawal (base token)",
        l2ChainId: CHAIN_IDs.ZK_SYNC,
        l2Sender: zksUtils.L2_BASE_TOKEN_ADDRESS,
        legacy: false,
      },
      {
        name: "zkSync USDT withdrawal (asset router)",
        l2ChainId: CHAIN_IDs.ZK_SYNC,
        l2Sender: zksUtils.L2_ASSET_ROUTER_ADDRESS,
        legacy: false,
      },
      {
        // The regression: Lens' base token is GHO, so WETH is an ordinary ERC-20 routed via the asset
        // router. Sending this through the legacy entrypoint reverts InvalidProof().
        name: "Lens WETH withdrawal (asset router)",
        l2ChainId: CHAIN_IDs.LENS,
        l2Sender: zksUtils.L2_ASSET_ROUTER_ADDRESS,
        legacy: false,
      },
      {
        name: "Lens GHO withdrawal (base token)",
        l2ChainId: CHAIN_IDs.LENS,
        l2Sender: zksUtils.L2_BASE_TOKEN_ADDRESS,
        legacy: true,
      },
      {
        // Withdrawals routed via the standalone USDC bridge are forced onto the legacy entrypoint by
        // prepareFinalizations(), since that bridge has no finalizeDeposit(). Pinned here too because this
        // sender must not be mistaken for an asset-router withdrawal.
        name: "Lens USDC withdrawal (standalone USDC bridge)",
        l2ChainId: CHAIN_IDs.LENS,
        l2Sender: LENS_L2_USDC_BRIDGE,
        legacy: true,
      },
    ];

    cases.forEach(({ name, l2ChainId, l2Sender, legacy }) => {
      it(`${name} -> ${legacy ? "finalizeWithdrawal" : "finalizeDeposit"}`, function () {
        expect(useLegacyFinalizeWithdrawal(l2ChainId, l2Sender)).to.equal(legacy);
      });
    });

    it("Is not case-sensitive on the l2Sender", function () {
      const { L2_ASSET_ROUTER_ADDRESS: assetRouter } = zksUtils;
      expect(useLegacyFinalizeWithdrawal(CHAIN_IDs.LENS, assetRouter.toUpperCase().replace("0X", "0x"))).to.be.false;
    });
  });
});
