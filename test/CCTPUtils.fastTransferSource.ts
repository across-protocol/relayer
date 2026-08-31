import { expect } from "./utils";
import { CHAIN_IDs } from "../src/utils";
import {
  CCTPV2_FINALITY_THRESHOLD_FAST,
  CCTPV2_FINALITY_THRESHOLD_STANDARD,
  isCctpFastTransferSource,
} from "../src/utils/CCTPUtils";

// Circle's Fast Transfer source list, as published at
// https://developers.circle.com/cctp/concepts/finality-and-block-confirmations.
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

// Circle downgrades a fast burn from these to standard. Unlisted rather than enumerated in the source, so these
// assert the opt-in default rather than a second list.
const STANDARD_ONLY_SOURCES = [
  CHAIN_IDs.ARC,
  CHAIN_IDs.AVALANCHE,
  CHAIN_IDs.HYPEREVM,
  CHAIN_IDs.MONAD,
  CHAIN_IDs.PLASMA,
  CHAIN_IDs.POLYGON,
];

const STANDARD_ONLY_TESTNET_SOURCES = [CHAIN_IDs.HYPEREVM_TESTNET, CHAIN_IDs.MONAD_TESTNET, CHAIN_IDs.POLYGON_AMOY];

// Chains with no CCTP deployment at all resolve to CCTP_NO_DOMAIN (-1). Asserting these guards the set builder: were
// -1 ever admitted to the fast set, every one of them would evaluate as a fast source.
const NO_CCTP_DEPLOYMENT_SOURCES = [CHAIN_IDs.BSC, CHAIN_IDs.LENS];

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
    NO_CCTP_DEPLOYMENT_SOURCES.forEach((chainId) => expect(isCctpFastTransferSource(chainId)).to.be.false);
  });
});

describe("CCTP finality thresholds", function () {
  // These are SDK constants, and we both send them as depositForBurn's minFinalityThreshold and derive the "fast
  // mode" log line from them. Circle's fee endpoint reports its two tiers as finalityThreshold 1000 and 2000, so pin
  // those values: an SDK bump that moved them would otherwise silently change what we sign.
  it("matches the thresholds Circle attests against", function () {
    expect(CCTPV2_FINALITY_THRESHOLD_FAST).to.equal(1000);
    expect(CCTPV2_FINALITY_THRESHOLD_STANDARD).to.equal(2000);
  });
});
