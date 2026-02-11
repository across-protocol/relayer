import { writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
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

function getLocalFileName(botIdentifier: string, inventoryConfigFilename?: string): string {
  // If the inventory config filename is set, use it. Otherwise, construct the default filename from the bot identifier.
  return inventoryConfigFilename ? inventoryConfigFilename : `inventory-${botIdentifier}.json`;
}

async function run(): Promise<number> {
  config();

  const {
    CONFIGURAMA_FOLDER_BASE_URL: configuramaBaseUrl,
    CONFIGURAMA_FOLDER_ENVIRONMENT: configuramaEnv = DEFAULT_ENVIRONMENT,
    CONFIGURAMA_FOLDER_PATH: configuramaFolderPath = "",
    BOT_IDENTIFIER: botIdentifier,
    INVENTORY_CONFIG_FILENAME: inventoryConfigFilename,
  } = process.env;

  if (!botIdentifier) {
    logger.error({
      at: "fetchInventoryConfig#run",
      message: "BOT_IDENTIFIER not set, skipping inventory config fetch",
    });
    return 0;
  }

  const localFile = getLocalFileName(botIdentifier, inventoryConfigFilename);

  // Helper to handle errors - fall back to local file if it exists.
  const handleError = (message: string): number => {
    if (existsSync(localFile)) {
      logger.warn({
        at: "fetchInventoryConfig#run",
        message,
        localFile,
      });
      logger.warn({
        at: "fetchInventoryConfig#run",
        message: "Local file exists, continuing with existing config",
        localFile,
      });
      return 0;
    }
    throw new Error(`${message} (and no local file "${localFile}" found)`);
  };

  if (!configuramaBaseUrl) {
    return handleError("CONFIGURAMA_FOLDER_BASE_URL environment variable is required");
  }

  const baseUrl = normalizeBaseUrl(configuramaBaseUrl);

  const configuramaFilePath = `${configuramaFolderPath}${localFile}`;

  logger.debug({
    at: "fetchInventoryConfig#run",
    message: "Fetching inventory config",
    botIdentifier,
    localFile,
    baseUrl,
    configuramaEnv,
    configuramaFilePath,
  });

  try {
    const headers = await getIdTokenHeaders(baseUrl);

    const url = `${baseUrl}/config?environment=${encodeURIComponent(configuramaEnv)}&filename=${encodeURIComponent(
      configuramaFilePath
    )}`;
    logger.debug({
      at: "fetchInventoryConfig#run",
      message: "Fetching from Configurama",
      configuramaFilePath,
    });

    const fileContent = await fetchWithRetry(url, headers);
    const jsonData = JSON.parse(fileContent);

    await writeFile(localFile, JSON.stringify(jsonData, null, 2));

    logger.debug({
      at: "fetchInventoryConfig#run",
      message: "Successfully saved inventory config",
      localFile,
    });
    return 0;
  } catch (error) {
    const errorMessage = getErrorMessage(error);
    return handleError(`Failed to fetch inventory config: ${errorMessage}`);
  }
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
