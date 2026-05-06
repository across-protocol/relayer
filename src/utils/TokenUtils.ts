import { CHAIN_IDs, TOKEN_EQUIVALENCE_REMAPPING, TOKEN_SYMBOLS_MAP } from "@across-protocol/constants";
import { constants, utils, arch } from "@across-protocol/sdk";
import { CONTRACT_ADDRESSES } from "../common";
import { BigNumberish, BigNumber } from "./BNUtils";
import { formatUnits, getL1TokenAddress as resolveL1TokenAddress, getTokenInfo } from "./SDKUtils";
import { isDefined, isKeyOf } from "./TypeGuards";
import { assert, Address, toAddressType, EvmAddress, SvmAddress, SVMProvider, toBN } from "./";
import { TokenInfo } from "../interfaces";

const { ZERO_ADDRESS } = constants;

export const { fetchTokenInfo, getL2TokenAddresses } = utils;

type TokenSymbolInfo = (typeof TOKEN_SYMBOLS_MAP)[keyof typeof TOKEN_SYMBOLS_MAP];

// Safely index TOKEN_SYMBOLS_MAP with a string key, returning undefined for unknown symbols.
// When chainId is supplied, returns the token address on that chain (or undefined).
// When assertExists is true, throws if the token (or address) is not found.
export function resolveAcrossToken(symbol: string): TokenSymbolInfo | undefined;
export function resolveAcrossToken(symbol: string, chainId: number): string | undefined;
export function resolveAcrossToken(symbol: string, chainId: number, assertExists: true): string;
export function resolveAcrossToken(
  symbol: string,
  chainId?: number,
  assertExists?: boolean
): TokenSymbolInfo | string | undefined {
  const token = isKeyOf(symbol, TOKEN_SYMBOLS_MAP) ? TOKEN_SYMBOLS_MAP[symbol] : undefined;
  if (chainId !== undefined) {
    const address = token?.addresses[chainId];
    assert(!assertExists || isDefined(address), `Token ${symbol} not found on chain ${chainId}`);
    return address;
  }
  return token;
}

// Returns the canonical token for the given L1 token on the given remote chain, assuming that the L1 token
// exists in only a single mapping in TOKEN_SYMBOLS_MAP. This is the case currently for all tokens except for
// USDC.e, but that's why we use the TOKEN_EQUIVALENCE_REMAPPING to remap the token back to its inventory
// equivalent L1 token.
export function getRemoteTokenForL1Token(
  _l1Token: EvmAddress,
  remoteChainId: number,
  hubChainId: number
): Address | undefined {
  const l1Token = _l1Token.toEvmAddress();
  const tokenMapping = Object.values(TOKEN_SYMBOLS_MAP).find(
    ({ addresses }) => addresses[hubChainId] === l1Token && isDefined(addresses[remoteChainId])
  );
  if (!tokenMapping) {
    return undefined;
  }
  const l1TokenSymbol = TOKEN_EQUIVALENCE_REMAPPING[tokenMapping.symbol] ?? tokenMapping.symbol;
  return toAddressType(
    resolveAcrossToken(l1TokenSymbol, remoteChainId) ?? tokenMapping.addresses[remoteChainId],
    remoteChainId
  );
}

// Returns the L1 token that is equivalent to the `l2Token` within the context of the inventory.
// This is used to link tokens that are not linked via pool rebalance routes, for example.
export function getInventoryEquivalentL1TokenAddress(
  l2Token: Address,
  chainId: number,
  hubChainId = CHAIN_IDs.MAINNET
): EvmAddress {
  try {
    return resolveL1TokenAddress(l2Token, chainId);
  } catch {
    const { symbol } = getTokenInfo(l2Token, chainId);
    const remappedSymbol = TOKEN_EQUIVALENCE_REMAPPING[symbol] ?? symbol;
    return EvmAddress.from(resolveAcrossToken(remappedSymbol, hubChainId, true));
  }
}

// Returns the L2 tokens that are equivalent for a given `l1Token` within the context of the inventory.
// Equivalency is defined by tokens that share the same L1 token within TOKEN_SYMBOLS_MAP or are
// mapped to each other in TOKEN_EQUIVALENCE_REMAPPING.
export function getInventoryBalanceContributorTokens(
  l1Token: EvmAddress,
  chainId: number,
  hubChainId = CHAIN_IDs.MAINNET
): Address[] {
  if (chainId === hubChainId) {
    return [l1Token];
  }

  const hubTokenSymbol = getTokenInfo(l1Token, hubChainId).symbol;
  const balanceContributorTokens: Address[] = [];
  const canonicalToken = getRemoteTokenForL1Token(l1Token, chainId, hubChainId);
  if (isDefined(canonicalToken)) {
    balanceContributorTokens.push(canonicalToken);
  }

  Object.values(TOKEN_SYMBOLS_MAP).forEach((token) => {
    const remappedSymbol = TOKEN_EQUIVALENCE_REMAPPING[token.symbol] ?? token.symbol;
    if (remappedSymbol === hubTokenSymbol && isDefined(token.addresses[chainId])) {
      balanceContributorTokens.push(toAddressType(token.addresses[chainId], chainId));
    }
  });

  return balanceContributorTokens.filter(
    (token, index, allTokens) => allTokens.findIndex((candidate) => candidate.eq(token)) === index
  );
}

// Returns true if the token symbol is an L2-only token that maps to a parent L1 token via
// TOKEN_EQUIVALENCE_REMAPPING (e.g. pathUSD -> USDC, USDH -> USDC). These tokens have no
// hub chain address and exist only on specific L2 chains.
export function isL2OnlyEquivalentToken(symbol: string, hubChainId = CHAIN_IDs.MAINNET): boolean {
  const remappedSymbol = TOKEN_EQUIVALENCE_REMAPPING[symbol];
  if (!isDefined(remappedSymbol)) {
    return false;
  }
  const tokenInfo = resolveAcrossToken(symbol);
  return isDefined(tokenInfo) && !isDefined(tokenInfo.addresses[hubChainId]);
}

export function getNativeTokenAddressForChain(chainId: number): Address {
  return toAddressType(CONTRACT_ADDRESSES[chainId]?.nativeToken?.address ?? ZERO_ADDRESS, chainId);
}

export function getNativeTokenInfoForChain(
  chainId: number,
  hubChainId = CHAIN_IDs.MAINNET
): {
  symbol: string;
  address: string;
  decimals: number;
} {
  const remappings = {
    [CHAIN_IDs.TEMPO]: "USDC.e",
  };
  const symbol = remappings[chainId] ?? utils.getNativeTokenSymbol(chainId);
  const token = resolveAcrossToken(symbol);
  if (!isDefined(symbol) || !isDefined(token)) {
    throw new Error(`Unable to resolve native token for chain ID ${chainId}`);
  }

  const { decimals, addresses } = token;

  const address = addresses[hubChainId] ?? addresses[chainId]; // Mainnet tokens have priority for price lookups.

  return { symbol, address, decimals };
}

export function getWrappedNativeTokenAddress(chainId: number): Address {
  const tokenSymbol = utils.getNativeTokenSymbol(chainId);
  // If the native token is ETH, then we know the wrapped native token is WETH. Otherwise, some ERC20 token is the native token.
  // In PUBLIC_NETWORKS, the native token symbol is the symbol corresponding to the L1 token contract, so "W" should not be prepended
  // to the symbol.
  const wrappedTokenSymbol = tokenSymbol === "ETH" ? "WETH" : tokenSymbol;

  // Undefined returns should be caught and handled by consumers of this function.
  return toAddressType(resolveAcrossToken(wrappedTokenSymbol, chainId), chainId);
}

/**
 * Format the given amount of tokens to the correct number of decimals for the given token symbol.
 * @param symbol The token symbol to format the amount for.
 * @param amount The amount to format.
 * @returns The formatted amount as a decimal-inclusive string.
 */
export function formatUnitsForToken(symbol: string, amount: BigNumberish): string {
  const decimals = resolveAcrossToken(symbol)?.decimals ?? 18;
  return formatUnits(amount, decimals);
}

/**
 * Format the given amount of tokens to the correct number of decimals for the given token symbol.
 * @param provider An SVM provider.
 * @param tokenMint The address of the Solana token.
 * @param walletAddress The address of the wallet to query.
 * @returns The wallet's balance of the input token.
 */
export async function getSolanaTokenBalance(
  provider: SVMProvider,
  tokenMint: SvmAddress,
  walletAddress: SvmAddress
): Promise<BigNumber> {
  // Convert addresses to the correct format for SVM provider
  const ownerPubkey = arch.svm.toAddress(walletAddress);
  const mintPubkey = arch.svm.toAddress(tokenMint);

  // Get token accounts owned by the wallet for this specific mint
  const tokenAccountsByOwner = await provider
    .getTokenAccountsByOwner(
      ownerPubkey,
      {
        mint: mintPubkey,
      },
      {
        encoding: "jsonParsed",
      }
    )
    .send();

  const response = tokenAccountsByOwner;
  if (!response.value || response.value.length === 0) {
    // No token account found for this mint, balance is 0
    return toBN(0);
  }

  // For SPL tokens, there should typically be only one token account per mint per owner
  // Sum all balances in case there are multiple accounts (rare but possible)
  const totalBalance = response.value.reduce((acc, accountInfo) => {
    const balance = accountInfo?.account?.data?.parsed?.info?.tokenAmount?.amount;
    return balance ? acc.add(toBN(balance)) : acc;
  }, toBN(0));

  return totalBalance;
}

/**
 * @notice Returns token info using l1 token symbol for chain ID. If token symbol is not an L1 token
 * symbol then this function will throw. This function will also throw if the token doesn't exist
 * on the chain.
 * @param l1TokenSymbol L1 token symbol to get the token info for.
 * @param chainId Chain ID to get the token info for.
 * @returns Token info for the given l1 token symbol and chain ID.
 */
export function getTokenInfoFromSymbol(l1TokenSymbol: string, chainId: number): TokenInfo {
  const { MAINNET } = CHAIN_IDs;
  const l1TokenAddress = EvmAddress.from(resolveAcrossToken(l1TokenSymbol, MAINNET, true));
  const l1TokenInfo = getTokenInfo(l1TokenAddress, MAINNET);

  if (chainId === CHAIN_IDs.MAINNET) {
    return l1TokenInfo;
  } else {
    const remoteTokenAddress = getRemoteTokenForL1Token(l1TokenAddress, chainId, MAINNET);
    if (!remoteTokenAddress) {
      throw new Error(`Unable to resolve remote token address for ${l1TokenSymbol} on chain ${chainId}`);
    }
    return getTokenInfo(remoteTokenAddress, chainId);
  }
}

export function getTokenSymbol(token: Address, chainId: number): string {
  try {
    const { symbol } = getTokenInfo(token, chainId);
    return symbol;
  } catch {
    return "UNKNOWN";
  }
}
