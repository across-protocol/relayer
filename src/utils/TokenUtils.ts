import { CHAIN_IDs, TOKEN_EQUIVALENCE_REMAPPING, TOKEN_SYMBOLS_MAP } from "@across-protocol/constants";
import { constants, utils, arch } from "@across-protocol/sdk";
import { CONTRACT_ADDRESSES } from "../common";
import { BigNumberish, BigNumber } from "./BNUtils";
import { formatUnits, getTokenInfo } from "./SDKUtils";
import { isDefined } from "./TypeGuards";
import { Address, toAddressType, EvmAddress, SvmAddress, SVMProvider, toBN } from "./";
import { TokenInfo } from "../interfaces";

const { ZERO_ADDRESS } = constants;

export const { fetchTokenInfo, getL2TokenAddresses } = utils;

export function getRemoteTokenForL1Token(
  _l1Token: EvmAddress,
  remoteChainId: number | string,
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
    TOKEN_SYMBOLS_MAP[l1TokenSymbol]?.addresses[remoteChainId] ?? tokenMapping.addresses[remoteChainId],
    Number(remoteChainId)
  );
}

export function getNativeTokenAddressForChain(chainId: number): Address {
  return toAddressType(CONTRACT_ADDRESSES[chainId]?.nativeToken?.address ?? ZERO_ADDRESS, chainId);
}

export function getWrappedNativeTokenAddress(chainId: number): Address {
  const tokenSymbol = utils.getNativeTokenSymbol(chainId);
  // If the native token is ETH, then we know the wrapped native token is WETH. Otherwise, some ERC20 token is the native token.
  // In PUBLIC_NETWORKS, the native token symbol is the symbol corresponding to the L1 token contract, so "W" should not be prepended
  // to the symbol.
  const wrappedTokenSymbol = tokenSymbol === "ETH" ? "WETH" : tokenSymbol;

  // Undefined returns should be caught and handled by consumers of this function.
  return toAddressType(TOKEN_SYMBOLS_MAP[wrappedTokenSymbol]?.addresses[chainId], chainId);
}

/**
 * Format the given amount of tokens to the correct number of decimals for the given token symbol.
 * @param symbol The token symbol to format the amount for.
 * @param amount The amount to format.
 * @returns The formatted amount as a decimal-inclusive string.
 */
export function formatUnitsForToken(symbol: string, amount: BigNumberish): string {
  const decimals = (TOKEN_SYMBOLS_MAP[symbol]?.decimals as number) ?? 18;
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
  const l1TokenAddress = EvmAddress.from(TOKEN_SYMBOLS_MAP[l1TokenSymbol]?.addresses[MAINNET]);
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
