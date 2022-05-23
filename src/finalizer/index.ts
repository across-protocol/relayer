// NOTE: The "finalizers/" directory structure is just a strawman and is expected to change. This script is just
// meant to demonstrate how we can use the new @arbitrum/sdk to finalize L2 --> L1 messages. Note that arb-ts
// will be deprecated soon so this scratch work will also be helpful for changing across-v1 code to work if we
// still need to finalize messages after the arbitrum nitro upgrade.
import { convertFromWei, delay, groupObjectCountsByThreeProps, Logger, Wallet } from "../utils";
import { getProvider, getSigner, winston } from "../utils";
import { constructClients, updateClients, updateSpokePoolClients } from "../common";
import { L2TransactionReceipt, getL2Network, L2ToL1MessageStatus, L2ToL1MessageWriter } from "@arbitrum/sdk";
import { RelayerConfig } from "../relayer/RelayerConfig";
import { constructSpokePoolClientsWithLookback } from "../relayer/RelayerClientHelper";
import { TokensBridged } from "../interfaces";

// How to run:
// - Set same config you'd need to run dataworker or relayer in terms of L2 node urls
// - ts-node ./src/finalizer/index.ts --wallet mnemonic

export async function run(logger: winston.Logger, config: RelayerConfig): Promise<void> {
  // Common set up with Dataworker/Relayer client helpers, can we refactor?
  const baseSigner = await getSigner();
  const hubSigner = baseSigner.connect(getProvider(config.hubPoolChainId));
  const commonClients = await constructClients(logger, config);
  const spokePoolClients = await constructSpokePoolClientsWithLookback(logger, commonClients, config, baseSigner);

  await updateClients(commonClients);
  await updateSpokePoolClients(spokePoolClients);

  // TODO: Load chain ID's from config rather than just hardcoding arbitrum here:
  const configuredChainIds = [42161];

  // For each chain, look up any TokensBridged events emitted by SpokePool client that we'll attempt to finalize
  // on L1.
  for (const chainId of configuredChainIds) {
    const client = spokePoolClients[chainId];
    const tokensBridged = client.getTokensBridged();
    logger.debug({
      at: "ArbitrumFinalizer",
      message: `Found ${tokensBridged.length} L2 transactions containing token transfers to L1`,
      txnHashes: tokensBridged.map((x) => x.transactionHash),
      tokens: tokensBridged.map((x) => commonClients.hubPoolClient.getTokenInfo(chainId, x.l2TokenAddress).symbol),
      tokenAddresses: tokensBridged.map((x) => x.l2TokenAddress),
      amountsToReturn: tokensBridged.map((x) =>
        convertFromWei(
          x.amountToReturn.toString(),
          commonClients.hubPoolClient.getTokenInfo(chainId, x.l2TokenAddress).decimals
        )
      ),
    });

    // Example test cases:
    //   // const tokenBridgedEventHashes = [
    //   //   "0x1d35b2fd1330ec331c74c9475115361d648f98014929471bdbee9fabe2c0b9da", // 3 USDC bridged on 05/17/22, can't be finalized until 05/24/22
    //   //   "0x92f9a0115830b037908c58e0ac4ff32619be09b17ceee6a5114c8d62c84c9a54", // 0.003 WETH bridged on 05/17/22, can't be finalized until 05/24/22
    //   //   "0x884c57cf97897a5c2b1af2c9197d5130961d06ef20e7d8d93265b3338b49d962", // 2.7mil USDC bridged on 05/12/22, finalized in 0x6e44001f4297646db2f7e99d32b72312d0c2bc9f3d6653cd21c129af947987f3
    //   // ]
    // const mockTokensBridged: TokensBridged[] = [
    //   {
    //     amountToReturn: toBN("3000000"),
    //     chainId: 42161,
    //     leafId: 0,
    //     l2TokenAddress: "0xFF970A61A04b1cA14834A43f5dE4533eBDDB5CC8",
    //     caller: "0x9a8f92a830a5cb89a3816e3d267cb7791c16b04d",
    //     transactionHash: "0x1d35b2fd1330ec331c74c9475115361d648f98014929471bdbee9fabe2c0b9da",
    //   },
    //   {
    //     amountToReturn: toBNWei("0.003"),
    //     chainId: 42161,
    //     leafId: 0,
    //     l2TokenAddress: "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1",
    //     caller: "0x9a8f92a830a5cb89a3816e3d267cb7791c16b04d",
    //     transactionHash: "0x92f9a0115830b037908c58e0ac4ff32619be09b17ceee6a5114c8d62c84c9a54",
    //   },
    //   {
    //     amountToReturn: toBN("2700000000000"),
    //     chainId: 42161,
    //     leafId: 0,
    //     l2TokenAddress: "0xFF970A61A04b1cA14834A43f5dE4533eBDDB5CC8",
    //     caller: "0x9a8f92a830a5cb89a3816e3d267cb7791c16b04d",
    //     transactionHash: "0x884c57cf97897a5c2b1af2c9197d5130961d06ef20e7d8d93265b3338b49d962",
    //   }
    // ]

    const finalizableMessages = await getFinalizableMessages(logger, tokensBridged, hubSigner);
    if (finalizableMessages.length > 0) {
      for (const l2Message of finalizableMessages) {
        const res = await l2Message.message.execute(l2Message.proofInfo);
        const rec = await res.wait();
        logger.info({
          at: "ArbitrumFinalizer",
          message: "Executed!",
          rec,
        });
      }
    } else
      logger.debug({
        at: "ArbitrumFinalizer",
        message: "No finalizable messages",
      });
  }
}

export async function finalizeL2Transaction(
  logger: winston.Logger,
  event: TokensBridged,
  l1Signer: Wallet
): Promise<{
  message: L2ToL1MessageWriter;
  proofInfo: any; // MessageBatchProofInfo not exported by arbitrum/sdk so just use type any for now
  status: string;
}> {
  logger.debug({
    at: "ArbitrumFinalizer",
    message: "Finalizing L2 transaction",
    chainId: event.chainId,
    txnHash: event.transactionHash,
    currency: event.l2TokenAddress,
    amountToReturn: event.amountToReturn.toString(),
  });
  const l2Provider = getProvider(event.chainId);
  const receipt = await l2Provider.getTransactionReceipt(event.transactionHash);
  const l2Receipt = new L2TransactionReceipt(receipt);

  // Get L2-to-L1 message objects contained in transaction. In principle, a single transaction could trigger
  // any number of outgoing messages; the common case will be there's only one. In the context of Across V2,
  // there should only ever be one.
  const l2ToL1Messages = await l2Receipt.getL2ToL1Messages(l1Signer, await getL2Network(l2Provider));
  if (l2ToL1Messages.length !== 1) {
    const error = new Error(`No (or wrong number) of outgoing messages found in transaction:${event.transactionHash}`);
    logger.error({
      at: "ArbitrumFinalizer",
      message:
        "Transaction that emitted TokensBridged event unexpectedly contains more than 1, or 0, L2-to-L1 messages 🤢!",
      txnHash: event.transactionHash,
      error,
    });
    // If this error gets thrown and blocks bots, can probably just remove and return something arbitrary like:
    // return {
    //   message: undefined,
    //   proofInfo: undefined,
    //   status: "ERROR",
    // };
    throw error;
  }
  const l2Message = l2ToL1Messages[0];

  // Now fetch the proof info we'll need in order to execute or check execution status.
  const proofInfo = await l2Message.tryGetProof(l2Provider);

  // Check if already executed or unconfirmed (i.e. not yet available to be executed on L1 following dispute
  // window)
  if (await l2Message.hasExecuted(proofInfo)) {
    logger.debug({
      at: "ArbitrumFinalizer",
      message: "Message already executed, nothing to do.",
    });
    return {
      message: l2Message,
      proofInfo: undefined,
      status: L2ToL1MessageStatus[L2ToL1MessageStatus.EXECUTED],
    };
  }
  const outboxMessageExecutionStatus = await l2Message.status(proofInfo);
  if (outboxMessageExecutionStatus !== L2ToL1MessageStatus.CONFIRMED) {
    logger.debug({
      at: "ArbitrumFinalizer",
      message: "Message is unconfirmed, nothing to do.",
      outboxMessageExecutionStatus: L2ToL1MessageStatus[outboxMessageExecutionStatus],
    });
    return {
      message: l2Message,
      proofInfo: undefined,
      status: L2ToL1MessageStatus[L2ToL1MessageStatus.UNCONFIRMED],
    };
  }

  // Now that its confirmed and not executed, we can use the Merkle proof data to execute our
  // message in its outbox entry.
  return {
    message: l2Message,
    proofInfo,
    status: L2ToL1MessageStatus[outboxMessageExecutionStatus],
  };
}

export async function getFinalizableMessages(logger: winston.Logger, tokensBridged: TokensBridged[], l1Signer: Wallet) {
  const l2MessagesToExecute = (
    await Promise.all(tokensBridged.map((event) => finalizeL2Transaction(logger, event, l1Signer)))
  ).map((result, index) => {
    return { ...result, chain: tokensBridged[index].chainId, token: tokensBridged[index].l2TokenAddress };
  });
  const statusesGrouped = groupObjectCountsByThreeProps(l2MessagesToExecute, "status", "chain", "token");
  logger.debug({
    at: "ArbitrumFinalizer",
    message: "Queried outbox statuses for messages",
    statusesGrouped,
  });
  return l2MessagesToExecute.filter((x) => x.status === L2ToL1MessageStatus[L2ToL1MessageStatus.CONFIRMED]);
}

// Refactor below to external index.ts entrypoint
if (require.main === module) {
  const config = new RelayerConfig(process.env);
  const logger = Logger;
  run(logger, config)
    .then(() => {
      process.exit(0);
    })
    .catch(async (error) => {
      console.error(error);
      logger.error({ at: "InfrastructureEntryPoint", message: "There was an error in the main entry point!", error });
      await delay(5);
      await run(logger, config);
    });
}
