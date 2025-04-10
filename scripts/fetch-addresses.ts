import { writeFile } from "node:fs/promises";
import { config } from "dotenv";
import { addressAdapters, AddressAggregator, Logger } from "../src/utils";

const OUTPUT_PATH = "addresses.json";

let logger: typeof Logger;

async function run(): Promise<number> {
  const addressList = new AddressAggregator(
    [new addressAdapters.risklabs.AddressList({ throwOnError: false })],
    logger
  );
  const addresses = await addressList.update();
  await writeFile(OUTPUT_PATH, JSON.stringify(addresses, null, 4));
  console.log(`Stored ${addresses.size} addresses at ${OUTPUT_PATH}.`);

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
