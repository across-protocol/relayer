import { writeFile } from "node:fs/promises";
import { config } from "dotenv";
import { addressAdapters, AddressAggregator } from "../src/utils";

const OUTPUT_PATH = "addresses.json";

async function run(): Promise<number> {
  const addressList = new AddressAggregator([
    new addressAdapters.bybit.AddressList(),
    new addressAdapters.processEnv.AddressList("IGNORED_ADDRESSES"),
  ]);
  const addresses = await addressList.update();
  await writeFile(OUTPUT_PATH, JSON.stringify(addresses, null, 4));
  console.log(`Stored ${addresses.size} addresses at ${OUTPUT_PATH}.`);

  return 0;
}

if (require.main === module) {
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
