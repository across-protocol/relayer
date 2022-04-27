// TODO: this can be replaced by an import from @uma/common when exported from the protocol package. The code herein is
// a reduced version of that found in common.
import kms from "@google-cloud/kms";
import { Storage } from "@google-cloud/storage";
import fs from "fs";
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

export function getGckmsConfig(keys) {
  let configOverride: GckmsConfig = {};
  if (process.env.GCKMS_CONFIG) {
    configOverride = JSON.parse(process.env.GCKMS_CONFIG);
  } else {
    const overrideFname = ".GckmsOverride.js";
    try {
      if (fs.existsSync(`${__dirname}/${overrideFname}`)) configOverride = require(`./${overrideFname}`);
    } catch (err) {
      console.error(err);
    }
  }

  const keyConfigs = keys.map((keyName) => {
    return configOverride["mainnet"][keyName] || {}; // Hardcode to "mainnet" network. This makes no impact key retrieval.
  });

  return keyConfigs;
}

export async function retrieveGckmsKeys(gckmsConfigs: KeyConfig[]): Promise<string[]> {
  return await Promise.all(
    gckmsConfigs.map(async (config) => {
      const storage = new Storage();
      const keyMaterialBucket = storage.bucket(config.ciphertextBucket);
      const ciphertextFile = keyMaterialBucket.file(config.ciphertextFilename);
      const contentsBuffer = (await ciphertextFile.download())[0];
      const ciphertext = contentsBuffer.toString("base64");
      const client = new kms.KeyManagementServiceClient(); // Send the request to decrypt the downloaded file.
      const name = client.cryptoKeyPath(config.projectId, config.locationId, config.keyRingId, config.cryptoKeyId);
      const [result] = await client.decrypt({ name, ciphertext });
      if (!(result.plaintext instanceof Uint8Array)) throw new Error("result.plaintext wrong type");
      return "0x" + Buffer.from(result.plaintext).toString().trim();
    })
  );
}
