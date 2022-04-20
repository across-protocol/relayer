// import { config } from "dotenv";
// config();
// import { getFallbackProvider, getProvider } from "./ProviderUtils";

// import { getDeployedContract, getSigner, paginatedEventQuery, getDeploymentBlockNumber } from "./index";

// export async function run(): Promise<void> {
//   console.log("RUN");
//   //   const provider = getFallbackProvider(10);
//   const provider = getProvider(421611);
//   const blockNumber = await provider.getBlockNumber();
//   console.log("CONNECTED", blockNumber);

//   const baseSigner = getSigner();

//   const connectedSigner = baseSigner.connect(provider);

//   const spokePool = getDeployedContract("SpokePool", 421611, connectedSigner);
//   console.log("SPOKEPOOL", spokePool.address);

//   console.log("OWNER", await spokePool.hubPool());

//   console.log("GETTING EVENTS");
//   //   const events = await spokePool.queryFilter(spokePool.filters.FundsDeposited());
//   const events = await paginatedEventQuery(
//     spokePool,
//     spokePool.filters.FundsDeposited(),
//     { fromBlock: getDeploymentBlockNumber("SpokePool", 421611), toBlock: blockNumber },
//     99990
//   );
//   console.log("events", events);
// }

// if (require.main === module) {
//   run()
//     .then(() => {
//       process.exit(0);
//     })
//     .catch(async (error) => {
//       console.log(error);
//       process.exit(1);
//     });
// }
