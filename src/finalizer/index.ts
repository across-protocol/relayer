// NOTE: The "finalizers/" directory structure is just a strawman and is expected to change.
import {
  Contract,
  convertFromWei,
  delay,
  ERC20,
  groupObjectCountsByThreeProps,
  Logger,
  Wallet,
  ethers,
  toBN,
} from "../utils";
import { getProvider, getSigner, winston, PolygonTokenBridger } from "../utils";
import { constructClients, updateClients, updateSpokePoolClients } from "../common";
import { L2TransactionReceipt, getL2Network, L2ToL1MessageStatus, L2ToL1MessageWriter } from "@arbitrum/sdk";
import { RelayerConfig } from "../relayer/RelayerConfig";
import { constructSpokePoolClientsWithLookback } from "../relayer/RelayerClientHelper";
import { TokensBridged } from "../interfaces";
import MaticJs, { setProofApi } from "@maticnetwork/maticjs";
import { Web3ClientPlugin } from "@maticnetwork/maticjs-ethers";

// How to run:
// - Set same config you'd need to relayer in terms of L2 node urls
// - ts-node ./src/finalizer/index.ts --wallet mnemonic

export async function run(logger: winston.Logger, config: RelayerConfig): Promise<void> {
  // Common set up with Dataworker/Relayer client helpers, can we refactor?
  const baseSigner = await getSigner();
  const hubSigner = baseSigner.connect(getProvider(config.hubPoolChainId));
  const commonClients = await constructClients(logger, config);
  const spokePoolClients = await constructSpokePoolClientsWithLookback(logger, commonClients, config, baseSigner);

  await updateClients(commonClients);
  await updateSpokePoolClients(spokePoolClients);

  // TODO: Load chain ID's from config
  const configuredChainIds = [137, 42161];

  // For each chain, look up any TokensBridged events emitted by SpokePool client that we'll attempt to finalize
  // on L1.
  for (const chainId of configuredChainIds) {
    const client = spokePoolClients[chainId];
    const tokensBridged = client.getTokensBridged();

    if (chainId === 42161) {
      const finalizableMessages = await getFinalizableMessages(logger, tokensBridged, hubSigner);
      if (finalizableMessages.length > 0) {
        logger.debug({
          at: "Finalizer",
          message: `Found ${finalizableMessages.length} L2 token bridges to L1 that are confirmed and can be finalized`,
          bridges: finalizableMessages.map((x) => {
            const copy: any = { ...x.info };
            const l1TokenCounterpart = commonClients.hubPoolClient.getL1TokenCounterpartAtBlock(
              x.chain.toString(),
              x.info.l2TokenAddress,
              commonClients.hubPoolClient.latestBlockNumber
            );
            const l1TokenInfo = commonClients.hubPoolClient.getTokenInfo(1, l1TokenCounterpart);
            copy.token = l1TokenInfo.symbol;
            copy.amountToReturn = convertFromWei(copy.amountToReturn.toString(), l1TokenInfo.decimals);
            delete copy.l2TokenAddress;
            return copy;
          }),
        });
        for (const l2Message of finalizableMessages) {
          logger.debug({
            at: "ArbitrumFinalizer",
            message: "Finalizing message",
            chain: l2Message.chain,
            token: l2Message.token,
          });
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
    } else if (chainId === 137) {
      // Following from https://maticnetwork.github.io/matic.js/docs/pos
      MaticJs.use(Web3ClientPlugin);
      setProofApi("https://apis.matic.network/");
      const posClient = new MaticJs.POSClient();
      await posClient.init({
        network: "mainnet",
        version: "v1",
        parent: {
          provider: hubSigner,
          defaultConfig: {
            from: baseSigner.address,
          },
        },
        child: {
          provider: baseSigner.connect(getProvider(chainId)),
          defaultConfig: {
            from: baseSigner.address,
          },
        },
      });
      const isCheckpointed = await Promise.all(
        tokensBridged.map((event) => posClient.exitUtil.isCheckPointed(event.transactionHash))
      );
      const withdrawExitedOrIsNotCheckpointed = await Promise.all(
        tokensBridged.map((event, i) => {
          if (!isCheckpointed[i]) return new Promise((resolve) => resolve(true));
          const l1TokenCounterpart = commonClients.hubPoolClient.getL1TokenCounterpartAtBlock(
            chainId.toString(),
            event.l2TokenAddress,
            commonClients.hubPoolClient.latestBlockNumber
          );
          return posClient.erc20(l1TokenCounterpart, true).isWithdrawExited(event.transactionHash);
        })
      );
      const canWithdraw = tokensBridged.filter((_, i) => !withdrawExitedOrIsNotCheckpointed[i]);
      if (canWithdraw.length === 0)
        logger.debug({
          at: "PolygonFinalizer",
          message: "No finalizable messages, will check for retrievals from token bridge",
        });
      for (const event of canWithdraw) {
        const l1TokenCounterpart = commonClients.hubPoolClient.getL1TokenCounterpartAtBlock(
          chainId.toString(),
          event.l2TokenAddress,
          commonClients.hubPoolClient.latestBlockNumber
        );
        logger.debug({
          at: "PolygonFinalizer",
          message: "Finalizable token bridge, submitting exit transaction",
          l1TokenCounterpart,
          event,
        });
        const result = await posClient.erc20(l1TokenCounterpart, true).withdrawExitFaster(event.transactionHash);
        const receipt = await result.getReceipt(); // Wait for confirmation.
        logger.info({
          at: "ArbitrumFinalizer",
          message: "Executed",
          receipt,
        });
      }

      // Batch retrieve any ERC20 in token bridge events from PolygonTokenBridger
      const mainnetTokenBridger = new Contract(
        "0x0330e9b4d0325ccff515e81dfbc7754f2a02ac57", // TODO: Read dynamically like we do with spoke pools
        PolygonTokenBridger.abi,
        hubSigner
      );
      const l1TokensSeen = [];
      for (const l2Token of tokensBridged.map((e) => e.l2TokenAddress)) {
        const l1TokenCounterpart = commonClients.hubPoolClient.getL1TokenCounterpartAtBlock(
          chainId.toString(),
          l2Token,
          commonClients.hubPoolClient.latestBlockNumber
        );
        if (l1TokensSeen.includes(l1TokenCounterpart)) continue;
        l1TokensSeen.push(l1TokenCounterpart);
        const l1TokenInfo = commonClients.hubPoolClient.getTokenInfo(1, l1TokenCounterpart);
        const l1Token = new Contract(l1TokenCounterpart, ERC20.abi, hubSigner);
        const balance = await l1Token.balanceOf(mainnetTokenBridger.address);
        if (balance.eq(toBN(0))) {
          logger.debug({
            at: "PolygonFinalizer",
            message: `No ${l1TokenInfo.symbol} balance to withdraw, skipping`,
          });
          continue;
        } else {
          logger.debug({
            at: "PolygonFinalizer",
            message: `Retrieving ${balance.toString()} ${l1TokenInfo.symbol}`,
          });
          const txn = await mainnetTokenBridger.retrieve(l1TokenCounterpart);
          const receipt = await txn.wait(); // Wait for confirmation.
          logger.info({
            at: "PolygonFinalizer",
            message: `Retrieved ${ethers.utils.formatUnits(balance.toString(), l1TokenInfo.decimals)} ${
              l1TokenInfo.symbol
            } from PolygonTokenBridger 🏧!`,
            transaction: receipt.transactionHash,
            l1Token: l1TokenCounterpart,
            amount: balance.toString(),
          });
        }
      }
    }
  }
}

// TODO: Replace this function with one that returns the transaction to send, which we can batch with other
// finalization transactions and multisend.
export async function finalizeL2Transaction(
  logger: winston.Logger,
  event: TokensBridged,
  l1Signer: Wallet,
  logIndex: number
): Promise<{
  message: L2ToL1MessageWriter;
  proofInfo: any; // MessageBatchProofInfo not exported by arbitrum/sdk so just use type any for now
  status: string;
}> {
  const l2Provider = getProvider(event.chainId);
  const receipt = await l2Provider.getTransactionReceipt(event.transactionHash);
  const l2Receipt = new L2TransactionReceipt(receipt);

  // Get L2-to-L1 message objects contained in transaction. In principle, a single transaction could trigger
  // any number of outgoing messages; the common case will be there's only one. In the context of Across V2,
  // there should only ever be one.
  const l2ToL1Messages = await l2Receipt.getL2ToL1Messages(l1Signer, await getL2Network(l2Provider));
  if (l2ToL1Messages.length === 0 || l2ToL1Messages.length - 1 < logIndex) {
    const error = new Error(`No outgoing messages found in transaction:${event.transactionHash}`);
    logger.error({
      at: "ArbitrumFinalizer",
      message: "Transaction that emitted TokensBridged event unexpectedly contains 0 L2-to-L1 messages 🤢!",
      logIndex,
      l2ToL1Messages: l2ToL1Messages.length,
      txnHash: event.transactionHash,
      error,
      notificationPath: "across-error",
    });
    // If this error gets thrown and blocks bots, can probably just remove and return something arbitrary like:
    // return {
    //   message: undefined,
    //   proofInfo: undefined,
    //   status: "ERROR",
    // };
    throw error;
  }

  const l2Message = l2ToL1Messages[logIndex];

  // Now fetch the proof info we'll need in order to execute or check execution status.
  const proofInfo = await l2Message.tryGetProof(l2Provider);

  // Check if already executed or unconfirmed (i.e. not yet available to be executed on L1 following dispute
  // window)
  if (await l2Message.hasExecuted(proofInfo)) {
    return {
      message: l2Message,
      proofInfo: undefined,
      status: L2ToL1MessageStatus[L2ToL1MessageStatus.EXECUTED],
    };
  }
  const outboxMessageExecutionStatus = await l2Message.status(proofInfo);
  if (outboxMessageExecutionStatus !== L2ToL1MessageStatus.CONFIRMED) {
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
  const uniqueTokenhashes = {};
  const logIndexesForMessage = [];
  for (const event of tokensBridged) {
    uniqueTokenhashes[event.transactionHash] = uniqueTokenhashes[event.transactionHash] ?? 0;
    const logIndex = uniqueTokenhashes[event.transactionHash];
    logIndexesForMessage.push(logIndex);
    uniqueTokenhashes[event.transactionHash] += 1;
  }
  const l2MessagesToExecute = (
    await Promise.all(tokensBridged.map((e, i) => finalizeL2Transaction(logger, e, l1Signer, logIndexesForMessage[i])))
  ).map((result, i) => {
    return {
      ...result,
      chain: tokensBridged[i].chainId,
      token: tokensBridged[i].l2TokenAddress,
      info: tokensBridged[i],
    };
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
      logger.error({
        at: "InfrastructureEntryPoint",
        message: "There was an error in the main entry point!",
        error,
        notificationPath: "across-error",
      });
      await delay(5);
      await run(logger, config);
    });
}
