import winston from "winston";
import { config } from "dotenv";
config();

import { getProvider, getSigner } from "../utils";
import { RelayerConfig } from "./RelayerConfig";

export async function runRelayer(logger: winston.Logger): Promise<void> {
  console.log("A");
  const config = new RelayerConfig(process.env);
  logger.debug({ at: "Relayer#index", message: "Relayer starting🏃‍♂️", config });

  const provider = getProvider(1);
  console.log("provider", provider);

  const signer = getSigner();
  console.log("signer", signer);
}
