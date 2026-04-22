import { writeFile } from "node:fs/promises";
import { config } from "dotenv";
import { addressAggregator } from "@across-protocol/sdk";
import { Logger } from "@risk-labs/logger";

const { AddressAggregator, adapters: addressAdapters } = addressAggregator;

const OUTPUT_PATH = "addresses.json";

let logger: typeof Logger;

async function run(): Promise<number> {
  const { RISKLABS_ADDRESS_LIST_HOSTNAME: path = "https://blacklist.risklabs.foundation/api/blacklist" } = process.env;
  const addressList = new AddressAggregator(
    [new addressAdapters.risklabs.AddressList({ path, throwOnError: false })],
    logger
  );
  const addressSet = await addressList.update();
  const addresses = Array.from(addressSet);
  await writeFile(OUTPUT_PATH, JSON.stringify(addresses, null, 4));
  console.log(`Stored ${addressSet.size} addresses at ${OUTPUT_PATH}.`);

  return 0;
}

if (require.main === module) {
  logger = Logger;
  config(); // Pull in any .env-configured addresses.
  run()
    .then((result: number) => {
      process.exitCode = result;
    })
    .catch((error) => {
      console.error("Process exited with", error);
      process.exitCode = 127;
    });
}
