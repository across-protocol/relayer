/* eslint-disable no-process-exit */
import { retrieveSignerFromCLIArgs, winston, Logger, assert, TOKEN_SYMBOLS_MAP } from "../src/utils";
import { CommonConfig, constructClients } from "../src/common";

// Example run commands:

// Disable USDC.e to and from Polygon
// $ ts-node ./scripts/toggleUSDC.ts
// \ --wallet mnemonic
// \ --chainId 137
// \ --enable false

// Enable Native USDC to and from Polygon
// $ ts-node ./scripts/toggleDepositRoute.ts
// \ --wallet mnemonic
// \ --chainId 137
// \ --enable true

import minimist from "minimist";
const args = minimist(process.argv.slice(2), {
  string: ["chainId"],
  boolean: ["enable"],
});

export function getTokenAddressForChain(l2ChainId: number, isNativeUsdc = false): string {
  if (isNativeUsdc) {
    const hasL2TokenEntry = TOKEN_SYMBOLS_MAP["_USDC"].addresses[l2ChainId] !== undefined;
    if (!hasL2TokenEntry) {
      throw new Error(`No token entry for _USDC on chain ${l2ChainId}`);
    }
    return TOKEN_SYMBOLS_MAP["_USDC"].addresses[l2ChainId];
  } else {
    const _tokenSymbol = l2ChainId === 8453 ? "USDbC" : "USDC.e";
    const hasL2TokenEntry = TOKEN_SYMBOLS_MAP[_tokenSymbol].addresses[l2ChainId] !== undefined;
    if (!hasL2TokenEntry) {
      throw new Error(`No token entry for ${_tokenSymbol} on chain ${l2ChainId}`);
    }
    return TOKEN_SYMBOLS_MAP[_tokenSymbol].addresses[l2ChainId];
  }
}

// Get symbol we should use for looking up addresses for l2ChainId in TOKEN_SYMBOLS_MAP.
export function getTokenSymbol(l2ChainId: number, isNativeUsdc = false): string {
  if (isNativeUsdc) {
    return "_USDC";
  } else {
    return l2ChainId === 8453 ? "USDbC" : "USDC.e";
  }
}

export async function run(logger: winston.Logger): Promise<void> {
  const chainId = Number(args.chainId);
  const enable = args.enable;
  assert(chainId && enable !== undefined);

  // If enabling routes, we want to enable Native USDC if it exists, otherwise enable USDC.e.
  const nativeUsdc = enable ? TOKEN_SYMBOLS_MAP["_USDC"].addresses[chainId] !== undefined : false;
  const tokenSymbol = getTokenSymbol(chainId, nativeUsdc);
  const token = getTokenAddressForChain(chainId, enable);
  logger.debug({
    at: "toggleDepositRoutes",
    message: `Toggling deposit routes to chain ${chainId} for ${
      nativeUsdc ? "native" : "bridged"
    } ${tokenSymbol} (${token}) and bridged USDC from all other chains`,
  });

  const baseSigner = await retrieveSignerFromCLIArgs();
  const config = new CommonConfig(process.env);

  // Get all deposit routes involving chainId and token
  const hubPoolLookBack = 7200;
  const commonClients = await constructClients(logger, config, baseSigner, hubPoolLookBack);
  const { hubPoolClient } = commonClients;
  const allChainIds = [1, 10, 137, 324, 42161, 8453, 59144];

  // Save all deposit routes involving chain ID that we want to toggle.
  /**
     *  function setDepositRoute(
            uint256 originChainId,
            uint256 destinationChainId,
            address originToken,
            bool depositsEnabled
        ) public override nonReentrant onlyOwner {
     */
  const routesToDisable: {
    originChainId: number;
    destinationChainId: number;
    originToken: string;
    depositsEnabled: boolean;
    originTokenSymbol: string;
  }[] = [];

  for (const _chainId of allChainIds) {
    // Toggle deposit routes to/from the target chain
    if (_chainId === chainId) {
      continue;
    }

    // If disabling routes, then assume we are disabling all USDC.e routes.
    // If enabling routes, then enable _USDC as an `outputToken` on the target chain and USDC.e as an `inputToken`.
    // These should not throw, otherwise it means there is a missing USDC.e/USDbC entry for the chain.
    const originTokenSymbol = getTokenSymbol(_chainId, false);
    const originTokenAddress = getTokenAddressForChain(_chainId, false);

    // Deposit route to target
    routesToDisable.push({
      originChainId: _chainId,
      destinationChainId: chainId,
      originToken: originTokenAddress,
      depositsEnabled: enable,
      originTokenSymbol: originTokenSymbol,
    });
    // Deposit route from target
    routesToDisable.push({
      originChainId: chainId,
      destinationChainId: _chainId,
      originToken: token,
      depositsEnabled: enable,
      originTokenSymbol: tokenSymbol,
    });
  }

  logger.debug({
    at: "toggleDepositRoutes",
    message: `Routes to ${enable ? "enable" : "disable"}`,
    routesToDisable,
  });

  // Construct multicall.
  const data = await Promise.all(
    routesToDisable.map((route) => {
      return hubPoolClient.hubPool.populateTransaction.setDepositRoute(
        route.originChainId,
        route.destinationChainId,
        route.originToken,
        route.depositsEnabled
      );
    })
  );
  const multicall = await hubPoolClient.hubPool.populateTransaction.multicall(data.map((tx) => tx.data));
  console.log("Data to pass to HubPool#multicall()", JSON.stringify(multicall.data));
}

if (require.main === module) {
  run(Logger)
    .then(async () => {
      process.exit(0);
    })
    .catch(async (error) => {
      console.error("Process exited with", error);
      process.exit(1);
    });
}
