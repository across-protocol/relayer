import { CHAIN_IDs, TOKEN_SYMBOLS_MAP } from "@across-protocol/constants";
import { expect } from "./utils";
import {
  expandAllowedSwapRouteV1,
  expandAllowedSwapRouteV2,
  normalizeSwapRouteChains,
} from "../src/relayer/RelayerConfig";

describe("allowedSwapRoutes expansion", function () {
  it("normalizeSwapRouteChains accepts ALL, a single chain, and arrays", function () {
    expect(normalizeSwapRouteChains("ALL")).to.equal("ALL");
    expect(normalizeSwapRouteChains(1)).to.deep.equal([1]);
    expect(normalizeSwapRouteChains([1, 10, 8453])).to.deep.equal([1, 10, 8453]);
  });

  it("expandAllowedSwapRouteV2 expands chain arrays into a cartesian product", function () {
    const routes = expandAllowedSwapRouteV2({
      fromChain: [CHAIN_IDs.MAINNET, CHAIN_IDs.OPTIMISM],
      fromToken: "USDT",
      toChain: [CHAIN_IDs.BASE],
      toToken: "USDC",
    });
    expect(routes).to.have.length(2);
    expect(routes.map((r) => r.fromChain).sort((a, b) => Number(a) - Number(b))).to.deep.equal([
      CHAIN_IDs.MAINNET,
      CHAIN_IDs.OPTIMISM,
    ]);
    expect(routes.every((r) => r.toChain === CHAIN_IDs.BASE)).to.equal(true);
    expect(routes[0].fromToken).to.equal(TOKEN_SYMBOLS_MAP.USDT.addresses[CHAIN_IDs.MAINNET]);
    expect(routes.every((r) => r.toToken === TOKEN_SYMBOLS_MAP.USDC.addresses[CHAIN_IDs.BASE])).to.equal(true);
  });

  it("expandAllowedSwapRouteV2 preserves ALL semantics", function () {
    const routes = expandAllowedSwapRouteV2({
      fromChain: "ALL",
      fromToken: "USDC",
      toChain: CHAIN_IDs.BASE,
      toToken: "USDT",
    });
    expect(routes.length).to.be.greaterThan(1);
    expect(routes.every((r) => r.fromChain === "ALL")).to.equal(true);
    expect(routes.every((r) => r.toChain === CHAIN_IDs.BASE)).to.equal(true);
    expect(routes.every((r) => r.toToken === TOKEN_SYMBOLS_MAP.USDT.addresses[CHAIN_IDs.BASE])).to.equal(true);
  });

  it("expandAllowedSwapRouteV1 still expands ALL token addresses", function () {
    const routes = expandAllowedSwapRouteV1({
      fromChain: "ALL",
      fromToken: "USDC",
      toChain: CHAIN_IDs.ROBINHOOD,
      toToken: "USDG",
    });
    expect(routes.length).to.equal(Object.values(TOKEN_SYMBOLS_MAP.USDC.addresses).length);
    expect(routes.every((r) => r.fromChain === "ALL")).to.equal(true);
    expect(routes.every((r) => r.toChain === CHAIN_IDs.ROBINHOOD)).to.equal(true);
  });
});
