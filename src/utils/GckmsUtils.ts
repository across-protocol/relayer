// TODO: this can be replaced by an import from @uma/common when exported from the protocol package. The code herein is
// a reduced version of that found in common.
import kms from "@google-cloud/kms";
import { Storage } from "@google-cloud/storage";
import fs from "fs";
import path from "path";

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

const DEFAULT_GCKMS_CONFIG_FILE = ".GckmsOverride.js";

function loadConfigOverride(filenameOrContent: string): GckmsConfig {
  // 1. Figure out the file path if we're dealing with the default `.GckmsOverride.js`
  const filePath =
    filenameOrContent === DEFAULT_GCKMS_CONFIG_FILE
      ? path.join(__dirname, DEFAULT_GCKMS_CONFIG_FILE)
      : path.resolve(process.cwd(), filenameOrContent);

  const doesFileExist = fs.existsSync(filePath);

  // 2. If a file exists, parse as a JavaScript module (the default file) or as JSON from file
  if (doesFileExist) {
    // Case: Default file is a module require
    if (filenameOrContent === DEFAULT_GCKMS_CONFIG_FILE) {
      try {
        return require(filePath);
      } catch (err) {
        throw new Error(`Failed to parse GCKMS_CONFIG from ${DEFAULT_GCKMS_CONFIG_FILE}`);
      }
    } else {
      // Case: arbitrary file as JSON
      try {
        return JSON.parse(fs.readFileSync(filePath, "utf8"));
      } catch {
        throw new Error(`Failed to parse GCKMS_CONFIG from ${filePath}. Bad JSON?`);
      }
    }
  }

  // 3. If it isn't a file, treat it as a JSON string
  try {
    return JSON.parse(filenameOrContent);
  } catch {
    throw new Error("Failed to parse GCKMS_CONFIG environment variable as JSON. Bad JSON?");
  }
}

/**
 * Retrieves the GCKMS config from the environment.
 *
 * The config can be set in one of two ways:
 * 1. `GCKMS_CONFIG` is set to a file path containing the config.
 * 2. `GCKMS_CONFIG` is set but a JSON string, in which case it will be parsed as a JSON object.
 *
 * If `GCKMS_CONFIG` is not set, the config will be read from the file `.GckmsOverride.js`.
 *
 * @param keys The keys to retrieve from the config.
 * @returns The GCKMS config.
 */
export function getGckmsConfig(keys: string[]): KeyConfig[] {
  const filenameOrContent = process.env.GCKMS_CONFIG || DEFAULT_GCKMS_CONFIG_FILE;
  const configOverride = loadConfigOverride(filenameOrContent);

  // Basic check
  if (Object.keys(configOverride).length === 0) {
    throw new Error("GCKMS_CONFIG is empty");
  }

  // 4. Retrieve keys
  const keyConfigs = keys.map((keyName: string): KeyConfig => {
    const config = configOverride["mainnet"][keyName];
    if (!config) {
      throw new Error(`Key configuration not found for key: ${keyName}`);
    }
    return config as KeyConfig;
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
