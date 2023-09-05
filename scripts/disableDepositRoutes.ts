/* eslint-disable no-process-exit */
import { retrieveSignerFromCLIArgs, winston, Logger, assert } from "../src/utils";
import { CommonConfig, constructClients, constructSpokePoolClientsWithStartBlocks, updateClients } from "../src/common";

import minimist from "minimist";
const args = minimist(process.argv.slice(2), {
  string: ["chainId"],
});

export async function run(logger: winston.Logger): Promise<void> {
  const enabledChains = [1, 10, 137, 42161];
  const chainsToDisable = args.chainId ? [args.chainId] : enabledChains;
  assert(
    chainsToDisable.length === enabledChains.length || chainsToDisable.length === 1,
    "Must define exactly one chain to disable or all"
  );
  logger.debug({
    at: "disableDepositRoutes",
    message: "Constructing data to disable all deposits to or from the following chains",
    chainsToDisable,
  });
  const baseSigner = await retrieveSignerFromCLIArgs();
  const config = new CommonConfig(process.env);

  // Get all deposit routes involving chainId and token
  const commonClients = await constructClients(logger, config, baseSigner);
  await updateClients(commonClients, config);
  const spokePoolClients = await constructSpokePoolClientsWithStartBlocks(
    logger,
    commonClients.hubPoolClient,
    config,
    baseSigner,
    {}, // Default setting fromBlocks = deployment blocks
    {}, // Default setting toBlocks = latest
    enabledChains
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
  for (const chainId of enabledChains) {
    const depositRoutesForChain = spokePoolClients[chainId].getDepositRoutes();
    for (const originToken of Object.keys(depositRoutesForChain)) {
      // If we want to disable this chainId, disable every route to every other chain from it.
      if (chainsToDisable.includes(chainId)) {
        for (const _destinationChainId of Object.keys(depositRoutesForChain[originToken])) {
          const destinationChainId = Number(_destinationChainId);
          routesToDisable.push({
            originChainId: chainId,
            destinationChainId: Number(destinationChainId),
            originToken,
            depositsEnabled: depositRoutesForChain[originToken][destinationChainId],
          });
        }
        // Otherwise, disable any routes where the disabled chain is the destination.
      } else {
        if (depositRoutesForChain[originToken][chainsToDisable[0]] !== undefined) {
          routesToDisable.push({
            originChainId: chainId,
            destinationChainId: chainsToDisable[0],
            originToken,
            depositsEnabled: depositRoutesForChain[originToken][chainsToDisable[0]],
          });
        }
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
