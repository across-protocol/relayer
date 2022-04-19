// TODO: this can be replaced by an import from @uma/common when exported.
import minimist from "minimist";
import fs from "fs";
import dotenv from "dotenv";
import { isPublicNetwork } from "@uma/common";

const argv = minimist(process.argv.slice());
dotenv.config();

// The anatomy of an individual config is:
//   projectId: ID of a Google Cloud project
//   keyRingId: ID of keyring
//   cryptoKeyId: ID of the crypto key to use for decrypting the key material
//   locationId: Google Cloud location, e.g., 'global'.
//   ciphertextBucket: ID of a Google Cloud storage bucket.
//   ciphertextFilename: Name of a file within `ciphertextBucket`.
export interface KeyConfig {
  projectId: string;
  locationId: string;
  keyRingId: string;
  cryptoKeyId: string;
  ciphertextBucket: string;
  ciphertextFilename: string;
}
export interface GckmsConfig {
  [network: string]: {
    [keyName: string]: KeyConfig;
  };
}

function arrayify(input: string[] | string | undefined): string[] {
  if (!input) return [];
  if (!Array.isArray(input)) return [input];
  return input;
}

export function getGckmsConfig(keys = arrayify(argv.keys), network = argv.network): KeyConfig[] {
  let configOverride: GckmsConfig = {};

  // If there is no env variable providing the config, attempt to pull it from a file.
  // TODO: this is kinda hacky. We should refactor this to only take in the config using one method.
  if (process.env.GCKMS_CONFIG) {
    // If the env variable is present, just take that json.
    configOverride = JSON.parse(process.env.GCKMS_CONFIG);
  } else {
    // Import the .GckmsOverride.js file if it exists.
    // Note: this file is expected to be present in the same directory as this script.
    const overrideFname = ".GckmsOverride.js";
    try {
      if (fs.existsSync(`${__dirname}/${overrideFname}`)) {
        configOverride = require(`./${overrideFname}`);
      }
    } catch (err) {
      console.error(err);
    }
  }

  const getNetworkName = () => {
    if (isPublicNetwork(network || "unknown")) {
      // Take everything before the underscore:
      // mainnet_gckms -> mainnet.
      return network.split("_")[0];
    }

    return "mainnet";
  };

  // Compose the exact config for this network.
  const networkConfig = configOverride[getNetworkName()];

  // Provide the configs for the keys requested.
  const keyConfigs = keys.map((keyName) => {
    return networkConfig[keyName] || {};
  });

  return keyConfigs as any;
}


import kms from "@google-cloud/kms";
import { Storage } from "@google-cloud/storage";
import type { KeyConfig } from "./GckmsConfig";

// This function takes an array of GCKMS configs that are shaped as follows:
// {
//   projectId: "project-name",
//   locationId: "asia-east2",
//   keyRingId: "Keyring_Test",
//   cryptoKeyId: "keyname",
//   ciphertextBucket: "cipher_bucket",
//   ciphertextFilename: "ciphertext_fname.enc",
// }
//
// It returns an array of private keys that can be used to send transactions.
export async function retrieveGckmsKeys(gckmsConfigs: KeyConfig[]): Promise<string[]> {
  return await Promise.all(
    gckmsConfigs.map(async (config) => {
      const storage = new Storage();
      const keyMaterialBucket = storage.bucket(config.ciphertextBucket);
      const ciphertextFile = keyMaterialBucket.file(config.ciphertextFilename);

      const contentsBuffer = (await ciphertextFile.download())[0];
      const ciphertext = contentsBuffer.toString("base64");

      // Send the request to decrypt the downloaded file.
      const client = new kms.KeyManagementServiceClient();
      const name = client.cryptoKeyPath(config.projectId, config.locationId, config.keyRingId, config.cryptoKeyId);
      const [result] = await client.decrypt({ name, ciphertext });
      if (!(result.plaintext instanceof Uint8Array)) throw new Error("result.plaintext wrong type");
      return "0x" + Buffer.from(result.plaintext).toString().trim();
    })
  );
}

module.exports = { retrieveGckmsKeys };
