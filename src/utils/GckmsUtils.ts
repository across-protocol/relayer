// TODO: this can be replaced by an import from @uma/common when exported from the protocol package. The code herein is
// a reduced version of that found in common.
import kms from "@google-cloud/kms";
import { Storage } from "@google-cloud/storage";
import fs from "fs";
import path from "node:path";
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

const { GCP_STORAGE_CONFIG } = process.env;

// Allows the environment to customize the config that's used to interact with google cloud storage.
// Relevant options can be found here: https://googleapis.dev/nodejs/storage/latest/global.html#StorageOptions.
// Specific fields of interest:
// - timeout: allows the env to set the timeout for all http requests.
// - retryOptions: object that allows the caller to specify how the library retries.
const storageConfig = GCP_STORAGE_CONFIG ? JSON.parse(GCP_STORAGE_CONFIG) : undefined;

export function getGckmsConfig(keys: string[]): KeyConfig[] {
  let configOverride: GckmsConfig = {};
  if (process.env.GCKMS_CONFIG) {
    const isFile = fs.existsSync(process.env.GCKMS_CONFIG);
    if (isFile) {
      configOverride = JSON.parse(fs.readFileSync(process.env.GCKMS_CONFIG, "utf8"));
    } else {
      configOverride = JSON.parse(process.env.GCKMS_CONFIG);
    }
  } else {
    const overrideFname = ".GckmsOverride.js";
    try {
      const filePath = path.join(__dirname, overrideFname);
      const doesFileExist = fs.existsSync(filePath);
      if (doesFileExist) {
        configOverride = require(filePath);
      } else {
        throw new Error(`GCKMS_CONFIG file not found at path: ${filePath}`);
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(err);
    }
  }

  if (Object.keys(configOverride).length === 0) {
    throw new Error("GCKMS_CONFIG is empty");
  }

  const keyConfigs = keys.map((keyName: string): KeyConfig => {
    return (configOverride["mainnet"][keyName] || {}) as KeyConfig; // Hardcode to "mainnet" network. This makes no impact key retrieval.
  });

  return keyConfigs;
}

export async function retrieveGckmsKeys(gckmsConfigs: KeyConfig[]): Promise<string[]> {
  return await Promise.all(
    gckmsConfigs.map(async (config) => {
      const storage = new Storage(storageConfig);
      const keyMaterialBucket = storage.bucket(config.ciphertextBucket);
      const ciphertextFile = keyMaterialBucket.file(config.ciphertextFilename);
      const contentsBuffer = (await ciphertextFile.download())[0];
      const ciphertext = contentsBuffer.toString("base64");
      const client = new kms.KeyManagementServiceClient(); // Send the request to decrypt the downloaded file.
      const name = client.cryptoKeyPath(config.projectId, config.locationId, config.keyRingId, config.cryptoKeyId);
      const [result] = await client.decrypt({ name, ciphertext });
      if (!(result.plaintext instanceof Uint8Array)) {
        throw new Error("result.plaintext wrong type");
      }
      return "0x" + Buffer.from(result.plaintext).toString().trim();
    })
  );
}
