import { expect } from "./utils";
import { CHAIN_IDs } from "../src/utils";
import { isCctpFastTransferSource } from "../src/utils/CCTPUtils";

// Circle's Fast Transfer source list, as published at
// https://developers.circle.com/cctp/concepts/finality-and-block-confirmations. Chains Across doesn't run on are
// omitted; every CCTP chain Across does run on is asserted here so that adding one forces a decision.
const FAST_SOURCES = [
  CHAIN_IDs.ARBITRUM,
  CHAIN_IDs.BASE,
  CHAIN_IDs.INK,
  CHAIN_IDs.LINEA,
  CHAIN_IDs.MAINNET,
  CHAIN_IDs.OPTIMISM,
  CHAIN_IDs.SOLANA,
  CHAIN_IDs.UNICHAIN,
  CHAIN_IDs.WORLD_CHAIN,
];

const STANDARD_ONLY_SOURCES = [
  CHAIN_IDs.ARC,
  CHAIN_IDs.AVALANCHE,
  CHAIN_IDs.HYPEREVM,
  CHAIN_IDs.MONAD,
  CHAIN_IDs.PLASMA,
  CHAIN_IDs.POLYGON,
];

describe("CCTP fast transfer sources", function () {
  it("accepts every chain Circle attests fast", function () {
    FAST_SOURCES.forEach((chainId) => expect(isCctpFastTransferSource(chainId)).to.be.true);
  });

  it("rejects chains whose fast burns Circle downgrades to standard", function () {
    STANDARD_ONLY_SOURCES.forEach((chainId) => expect(isCctpFastTransferSource(chainId)).to.be.false);
  });

  it("rejects chains with no CCTP deployment", function () {
    expect(isCctpFastTransferSource(CHAIN_IDs.BSC)).to.be.false;
    expect(isCctpFastTransferSource(CHAIN_IDs.LENS)).to.be.false;
  });
});
