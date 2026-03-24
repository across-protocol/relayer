import { writeFile } from "node:fs/promises";
import { config } from "dotenv";
import axios from "axios";
import { GoogleAuth } from "google-auth-library";
import { Logger, waitForLogger, delay } from "../src/utils";

const DEFAULT_ENVIRONMENT = "prod";
const AUTH_TIMEOUT_MS = 30000;

let logger: typeof Logger;

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, operationName: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`${operationName} timed out after ${timeoutMs}ms`)), timeoutMs)
    ),
  ]);
}

async function fetchWithRetry(
  url: string,
  headers: Record<string, string>,
  retries = 3,
  delayMs = 1000
): Promise<string> {
  for (let i = 0; i < retries; i++) {
    try {
      const response = await axios.get(url, { headers, responseType: "text", timeout: 30000 });
      return response.data as string;
    } catch (error) {
      if (i === retries - 1) {
        throw error;
      }
      logger.warn({
        at: "fetchInventoryConfig#fetchWithRetry",
        message: "Request failed, retrying",
        attempt: `${i + 1}/${retries}`,
        delayMs,
      });
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  throw new Error("Failed to fetch file from Configurama");
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;
}

async function getIdTokenHeaders(audience: string): Promise<Record<string, string>> {
  logger.debug({
    at: "fetchInventoryConfig#getIdTokenHeaders",
    message: "Obtaining Google Auth credentials",
  });
  const auth = new GoogleAuth();
  const client = await withTimeout(auth.getIdTokenClient(audience), AUTH_TIMEOUT_MS, "Google Auth getIdTokenClient");
  logger.debug({
    at: "fetchInventoryConfig#getIdTokenHeaders",
    message: "Getting request headers",
  });
  const headers = await withTimeout(client.getRequestHeaders(), AUTH_TIMEOUT_MS, "Google Auth getRequestHeaders");
  logger.debug({
    at: "fetchInventoryConfig#getIdTokenHeaders",
    message: "Authentication successful",
  });
  return headers as Record<string, string>;
}

type ConfigKind = "relayer" | "rebalancer";

/** One config to optionally fetch: external filename (what to fetch) and internal env (fallback when fetch fails). */
type ConfigSpec = {
  kind: ConfigKind;
  externalEnv: string | undefined;
  internalEnv: string | undefined;
  label: string;
};

/**
 * Flow per config:
 * - External not defined → skip.
 * - External defined → try fetch; on success write file. On failure: if internal defined → ok (warn); else error.
 */
async function run(): Promise<number> {
  config();

  const {
    CONFIGURAMA_FOLDER_BASE_URL: configuramaBaseUrl,
    CONFIGURAMA_FOLDER_ENVIRONMENT: configuramaEnv = DEFAULT_ENVIRONMENT,
    CONFIGURAMA_FOLDER_PATH: configuramaFolderPath = "",
    RELAYER_EXTERNAL_INVENTORY_CONFIG: relayerExternal,
    RELAYER_INVENTORY_CONFIG: relayerInternal,
    REBALANCER_EXTERNAL_CONFIG: rebalancerExternal,
    REBALANCER_CONFIG: rebalancerInternal,
  } = process.env;

  const specs: ConfigSpec[] = [
    { kind: "relayer", externalEnv: relayerExternal, internalEnv: relayerInternal, label: "relayer inventory" },
    { kind: "rebalancer", externalEnv: rebalancerExternal, internalEnv: rebalancerInternal, label: "rebalancer" },
  ];

  const toFetch = specs.filter((s) => s.externalEnv);
  if (toFetch.length === 0) {
    logger.debug({
      at: "fetchInventoryConfig#run",
      message: "No external config defined (RELAYER_EXTERNAL_INVENTORY_CONFIG, REBALANCER_EXTERNAL_CONFIG), skipping",
    });
    return 0;
  }

  if (!configuramaBaseUrl) {
    throw new Error("CONFIGURAMA_FOLDER_BASE_URL is required when an external config is defined");
  }

  const baseUrl = normalizeBaseUrl(configuramaBaseUrl);
  const headers = await getIdTokenHeaders(baseUrl);

  for (const spec of toFetch) {
    const localFilename = spec.externalEnv as string;
    const configuramaFilePath = `${configuramaFolderPath}${localFilename}`;
    const url = `${baseUrl}/config?environment=${encodeURIComponent(configuramaEnv)}&filename=${encodeURIComponent(
      configuramaFilePath
    )}`;

    try {
      logger.debug({
        at: "fetchInventoryConfig#run",
        message: "Fetching from Configurama",
        label: spec.label,
        configuramaFilePath,
      });
      const fileContent = await fetchWithRetry(url, headers);
      const jsonData = JSON.parse(fileContent);
      await writeFile(localFilename, JSON.stringify(jsonData, null, 2));
      logger.debug({
        at: "fetchInventoryConfig#run",
        message: "Successfully saved config",
        label: spec.label,
        localFile: localFilename,
      });
    } catch (error) {
      const errorMessage = getErrorMessage(error);
      if (spec.internalEnv) {
        logger.warn({
          at: "fetchInventoryConfig#run",
          message: `Failed to fetch ${spec.label}, internal config is defined so continuing`,
          localFile: localFilename,
          error: errorMessage,
        });
      } else {
        throw new Error(
          `Failed to fetch ${spec.label}: ${errorMessage}. Set internal config (${
            spec.kind === "relayer" ? "RELAYER_INVENTORY_CONFIG" : "REBALANCER_CONFIG"
          }) to allow fallback when fetch fails.`
        );
      }
    }
  }

  return 0;
}

function getErrorMessage(error: unknown): string {
  if (axios.isAxiosError(error)) {
    if (error.response?.status === 404) {
      return "File not found in Configurama";
    } else if (error.response?.status === 401 || error.response?.status === 403) {
      return "Authentication failed. Ensure ADC is configured to call the Configurama API.";
    } else {
      return `Configurama API error: ${error.response?.status} - ${error.message}`;
    }
  }
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

if (require.main === module) {
  logger = Logger;
  let exitCode = 0;
  run()
    .then((result: number) => {
      exitCode = result;
    })
    .catch((error) => {
      exitCode = 127;
      const errorMessage = error instanceof Error ? error.message : String(error);
      const errorStack = error instanceof Error ? error.stack : undefined;
      logger.error({
        at: "fetchInventoryConfig",
        message: "Process exited with error",
        error: errorMessage,
        stack: errorStack,
      });
    })
    .finally(async () => {
      await waitForLogger(logger);
      await delay(5);
      // eslint-disable-next-line no-process-exit
      process.exit(exitCode);
    });
}
