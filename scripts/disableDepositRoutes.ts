/* eslint-disable no-process-exit */
import { getSigner, winston, Logger } from "../src/utils";
import {
  CHAIN_ID_LIST_INDICES,
  CommonConfig,
  constructClients,
  constructSpokePoolClientsWithStartBlocks,
  updateClients,
} from "../src/common";
const args = require("minimist")(process.argv.slice(2), {
  number: ["chainId"],
});

export async function run(logger: winston.Logger): Promise<void> {
  if (!Object.keys(args).includes("chainId"))
    throw new Error("Define `chainId` as the chain you want to disable routes to/from");
  const chainToDisable = args.chainId;
  const baseSigner = await getSigner();
  const config = new CommonConfig(process.env);

  // Get all deposit routes involving chainId and token
  const commonClients = await constructClients(logger, config, baseSigner);
  await updateClients(commonClients);
  const spokePoolClients = await constructSpokePoolClientsWithStartBlocks(
    logger,
    commonClients.configStoreClient,
    config,
    baseSigner,
    {}, // Default setting fromBlocks = deployment blocks
    {}, // Default setting toBlocks = latest
    CHAIN_ID_LIST_INDICES
  );
  await Promise.all(Object.values(spokePoolClients).map((client) => client.update(["EnabledDepositRoute"])));

  // Save all deposit routes involving chain ID that we want to disable.
  /**
     *  function setDepositRoute(
            uint256 originChainId,
            uint256 destinationChainId,
            address originToken,
            bool depositsEnabled
        ) public override nonReentrant onlyOwner {
     */
  let routesToDisable: {
    originChainId: number;
    destinationChainId: number;
    originToken: string;
    depositsEnabled: boolean;
  }[] = [];
  for (const chainId of CHAIN_ID_LIST_INDICES) {
    const depositRoutesForChain = spokePoolClients[chainId].getDepositRoutes();
    for (const originToken of Object.keys(depositRoutesForChain)) {
      // If chainId is the one we want to disable, disable every route to every other chain from it.
      if (chainId === chainToDisable) {
        for (const destinationChainId of Object.keys(depositRoutesForChain[originToken])) {
          routesToDisable.push({
            originChainId: chainId,
            destinationChainId: Number(destinationChainId),
            originToken,
            depositsEnabled: depositRoutesForChain[originToken][destinationChainId],
          });
        }
        // Otherwise, disable any routes where the disabled chain is the destination.
      } else {
        if (depositRoutesForChain[originToken][chainToDisable] !== undefined)
          routesToDisable.push({
            originChainId: chainId,
            destinationChainId: chainToDisable,
            originToken,
            depositsEnabled: depositRoutesForChain[originToken][chainToDisable],
          });
      }
    }
  }

  // Remove all already disabled routes.
  routesToDisable = routesToDisable.filter((route) => route.depositsEnabled);
  logger.debug({
    at: "disableDepositRoutes",
    message: "Routes to disable",
    routesToDisable,
  });

  // Construct multicall.
  const data = await Promise.all(
    routesToDisable.map((route) => {
      return commonClients.hubPoolClient.hubPool.populateTransaction.setDepositRoute(
        route.originChainId,
        route.destinationChainId,
        route.originToken,
        false
      );
    })
  );
  const multicall = await commonClients.hubPoolClient.hubPool.populateTransaction.multicall(data.map((tx) => tx.data));
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
