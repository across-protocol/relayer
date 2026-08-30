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

// Circle assigns a testnet the same CCTP domain as its mainnet counterpart, so fast capability has to track the
// mainnet chain above it. Verified against the sandbox fee API, which returns the same non-zero threshold-1000 fee
// for these domains as production does.
const FAST_TESTNET_SOURCES = [
  CHAIN_IDs.ARBITRUM_SEPOLIA,
  CHAIN_IDs.BASE_SEPOLIA,
  CHAIN_IDs.OPTIMISM_SEPOLIA,
  CHAIN_IDs.SEPOLIA,
  CHAIN_IDs.SOLANA_DEVNET,
  CHAIN_IDs.UNICHAIN_SEPOLIA,
];

const STANDARD_ONLY_SOURCES = [
  CHAIN_IDs.ARC,
  CHAIN_IDs.AVALANCHE,
  CHAIN_IDs.HYPEREVM,
  CHAIN_IDs.MONAD,
  CHAIN_IDs.POLYGON,
];

const STANDARD_ONLY_TESTNET_SOURCES = [CHAIN_IDs.HYPEREVM_TESTNET, CHAIN_IDs.MONAD_TESTNET, CHAIN_IDs.POLYGON_AMOY];

describe("CCTP fast transfer sources", function () {
  it("accepts every chain Circle attests fast", function () {
    FAST_SOURCES.forEach((chainId) => expect(isCctpFastTransferSource(chainId)).to.be.true);
  });

  it("accepts testnets sharing a fast mainnet's CCTP domain", function () {
    FAST_TESTNET_SOURCES.forEach((chainId) => expect(isCctpFastTransferSource(chainId)).to.be.true);
  });

  it("rejects chains whose fast burns Circle downgrades to standard", function () {
    STANDARD_ONLY_SOURCES.forEach((chainId) => expect(isCctpFastTransferSource(chainId)).to.be.false);
  });

  it("rejects testnets sharing a standard-only mainnet's CCTP domain", function () {
    STANDARD_ONLY_TESTNET_SOURCES.forEach((chainId) => expect(isCctpFastTransferSource(chainId)).to.be.false);
  });

  it("rejects chains with no CCTP deployment", function () {
    // Plasma has no CCTP domain either, despite appearing alongside standard-only chains in Circle's fee tables.
    expect(isCctpFastTransferSource(CHAIN_IDs.BSC)).to.be.false;
    expect(isCctpFastTransferSource(CHAIN_IDs.LENS)).to.be.false;
    expect(isCctpFastTransferSource(CHAIN_IDs.PLASMA)).to.be.false;
  });
});
