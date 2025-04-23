import {
  ethers,
  retrieveSignerFromCLIArgs,
  getProvider,
  getGasPrice,
  toGWei,
  CHAIN_IDs,
  TOKEN_SYMBOLS_MAP,
  chainIsProd,
  EvmAddress,
  winston,
  chainIsEvm,
  getNodeUrlList,
} from "../src/utils";
import { providers } from "@across-protocol/sdk";
import { Rpc, SolanaRpcApi } from "@solana/kit";
import { SUPPORTED_TOKENS, CANONICAL_BRIDGE, CUSTOM_BRIDGE } from "../src/common";
import { SpokePoolClient } from "../src/clients";
import { BaseChainAdapter } from "../src/adapter";
import minimist from "minimist";
import { createConsoleTransport } from "@uma/logger";
const args = minimist(process.argv.slice(2), {
  string: ["token", "to", "amount", "chainId", "nonce", "maxFeePerGas", "maxPriorityFeePerGas"],
});
let logger: winston.Logger;

// Example run:
// ts-node ./scripts/sendTokensCrossChain.ts
// \ --token 0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48
// \ --to [EVM address or SVM public key]
// \ --amount 350000000000
// \ --destinationChainId 130
// \ --wallet gckms
// \ --keys bot1

// Example run to clear up a stuck nonce with a maxFeePerGas of 1 Gwei and a maxPriorityFeePerGas of 2 Gwei
// ts-node ./scripts/sendTokens.ts
// \ --token 0x
// \ --amount 0 --to <self-EOA>
// \ --destinationChainId 1868
// \ --nonce 100
// \ --maxFeePerGas 1
// \ --maxPriorityFeePerGas 2
// \ --wallet gckms
// \ --keys bot4

export async function run(): Promise<void> {
  console.log("Executing Token sender 💸");
  if (!Object.keys(args).includes("token")) {
    throw new Error("Define `token` as the address of the token to send");
  }
  if (!Object.keys(args).includes("amount")) {
    throw new Error("Define `amount` as how much you want to send");
  }
  if (!Object.keys(args).includes("to")) {
    throw new Error("Define `to` as where you want to send funds to");
  }
  if (!Object.keys(args).includes("destinationChainId")) {
    throw new Error("Define `destinationChainId as the chain you want to send tokens to");
  }
  if (args.destinationChainId === CHAIN_IDs.MAINNET) {
    throw new Error("Cannot send tokens cross chain with destination mainnet.");
  }
  logger = winston.createLogger({
    level: "debug",
    transports: [createConsoleTransport()],
  });
  const hubChain = chainIsProd(args.destinationChainId) ? CHAIN_IDs.MAINNET : CHAIN_IDs.SEPOLIA;
  const baseSigner = await retrieveSignerFromCLIArgs();
  const signerAddr = await baseSigner.getAddress();
  const connectedSigner = baseSigner.connect(await getProvider(hubChain));
  let provider;
  if (chainIsEvm(args.destinationChainId)) {
    provider = await getProvider(args.destinationChainId);
  } else {
    const rpcUrlList = getNodeUrlList(args.destinationChainId);
    const url = Object.values(rpcUrlList)[0];
    const providerFactory = new providers.CachedSolanaRpcFactory(
      "sdk-test",
      undefined,
      10,
      0,
      undefined,
      url,
      args.destinationChainId
    );
    provider = providerFactory.createRpcClient();
  }
  console.log("Connected to account", signerAddr);
  const token = EvmAddress.from(args.token);
  const nonce = args.nonce ? Number(args.nonce) : undefined;
  const maxFeePerGas = args.maxFeePerGas ? toGWei(args.maxFeePerGas) : undefined;
  const maxPriorityFeePerGas = args.maxFeePerGas ? toGWei(args.maxFeePerGas) : undefined;
  const gas =
    maxFeePerGas && maxPriorityFeePerGas
      ? { maxFeePerGas, maxPriorityFeePerGas }
      : await getGasPrice(connectedSigner.provider);
  console.log(
    `Submitting txn with maxFeePerGas ${gas.maxFeePerGas.toString()} and priority fee ${gas.maxPriorityFeePerGas.toString()} with overridden nonce ${nonce}`
  );
  const constructBridges = (chainId: number) => {
    return Object.fromEntries(
      SUPPORTED_TOKENS[chainId]?.map((symbol) => {
        const l1Token = TOKEN_SYMBOLS_MAP[symbol].addresses[hubChain];
        const bridgeConstructor = CUSTOM_BRIDGE[chainId]?.[l1Token] ?? CANONICAL_BRIDGE[chainId];
        const bridge = new bridgeConstructor(chainId, hubChain, baseSigner, provider, EvmAddress.from(l1Token));
        return [l1Token, bridge];
      }) ?? []
    );
  };
  const l2ToBlockResolver = async () => {
    if (chainIsEvm(args.destinationChainId)) {
      return await (provider as ethers.providers.Provider).getBlockNumber();
    }
    return Number(await (provider as Rpc<SolanaRpcApi>).getBlockHeight().send());
  };
  const l2ToBlock = await l2ToBlockResolver();
  const l1ToBlock = await connectedSigner.provider.getBlockNumber();
  const adapter = new BaseChainAdapter(
    {
      [hubChain]: {
        latestBlockSearched: l1ToBlock,
        eventSearchConfig: {
          fromBlock: l1ToBlock - 100,
          toBlock: l1ToBlock,
          maxBlockLookback: 100,
        },
      } as unknown as SpokePoolClient,
      [args.destinationChainId]: {
        latestBlockSearched: l1ToBlock,
        eventSearchConfig: {
          fromBlock: l2ToBlock - 100,
          toBlock: l2ToBlock,
          maxBlockLookback: 100,
        },
      } as unknown as SpokePoolClient,
    },
    args.destinationChainId,
    hubChain,
    [EvmAddress.from(signerAddr)],
    logger,
    SUPPORTED_TOKENS[args.destinationChainId],
    constructBridges(args.destinationChainId),
    {},
    1
  );
  const outstandingTransfers = await adapter.getOutstandingCrossChainTransfers([token]);
  console.log(outstandingTransfers);
}

if (require.main === module) {
  run()
    .then(async () => {
      // eslint-disable-next-line no-process-exit
      process.exit(0);
    })
    .catch(async (error) => {
      console.error("Process exited with", error);
      // eslint-disable-next-line no-process-exit
      process.exit(1);
    });
}
