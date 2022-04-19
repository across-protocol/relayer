import { config } from "dotenv";
config();
import { getFallbackProvider } from "./ProviderUtils";

export async function run(): Promise<void> {
  console.log("RUN");
  const provider = getFallbackProvider(10);
  console.log("CONNECTED", await provider.getBlockNumber());
}

if (require.main === module) {
  run()
    .then(() => {
      process.exit(0);
    })
    .catch(async (error) => {
      console.log(error);
      process.exit(1);
    });
}
