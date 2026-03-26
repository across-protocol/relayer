import { expect } from "./utils";
import {
  CHAIN_IDs,
  EvmAddress,
  getInventoryBalanceContributorTokens,
  getInventoryEquivalentL1TokenAddress,
  TOKEN_SYMBOLS_MAP,
  toAddressType,
} from "../src/utils";

describe("TokenUtils", function () {
  it("resolves inventory-equivalent L1 tokens for L2-only remapped tokens", function () {
    const l1Token = getInventoryEquivalentL1TokenAddress(
      toAddressType(TOKEN_SYMBOLS_MAP.pathUSD.addresses[CHAIN_IDs.TEMPO], CHAIN_IDs.TEMPO),
      CHAIN_IDs.TEMPO,
      CHAIN_IDs.MAINNET
    );

    expect(l1Token.eq(EvmAddress.from(TOKEN_SYMBOLS_MAP.USDC.addresses[CHAIN_IDs.MAINNET]))).to.be.true;
  });

  it("derives all Tempo USDC balance contributors from TOKEN_EQUIVALENCE_REMAPPING", function () {
    const contributorTokens = getInventoryBalanceContributorTokens(
      EvmAddress.from(TOKEN_SYMBOLS_MAP.USDC.addresses[CHAIN_IDs.MAINNET]),
      CHAIN_IDs.TEMPO,
      CHAIN_IDs.MAINNET
    ).map((token) => token.toNative());

    expect(contributorTokens).to.deep.equal([
      TOKEN_SYMBOLS_MAP["USDC.e"].addresses[CHAIN_IDs.TEMPO],
      TOKEN_SYMBOLS_MAP.pathUSD.addresses[CHAIN_IDs.TEMPO],
    ]);
  });

  it("derives non-pathUSD contributors generically from existing remappings", function () {
    const contributorTokens = getInventoryBalanceContributorTokens(
      EvmAddress.from(TOKEN_SYMBOLS_MAP.DAI.addresses[CHAIN_IDs.MAINNET]),
      CHAIN_IDs.BLAST,
      CHAIN_IDs.MAINNET
    ).map((token) => token.toNative());

    expect(contributorTokens).to.deep.equal([TOKEN_SYMBOLS_MAP.USDB.addresses[CHAIN_IDs.BLAST]]);
  });
});
