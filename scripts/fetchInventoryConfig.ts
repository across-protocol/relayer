import { writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { config } from "dotenv";
import axios from "axios";
import { GoogleAuth } from "google-auth-library";

const DEFAULT_ENVIRONMENT = "prod";
const AUTH_TIMEOUT_MS = 30000;

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
      console.log(`⚠️  Request failed (attempt ${i + 1}/${retries}). Retrying in ${delayMs}ms...`);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  throw new Error("Failed to fetch file from Configurama");
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;
}

async function getIdTokenHeaders(audience: string): Promise<Record<string, string>> {
  console.log("🔐 Obtaining Google Auth credentials...");
  const auth = new GoogleAuth();
  const client = await withTimeout(auth.getIdTokenClient(audience), AUTH_TIMEOUT_MS, "Google Auth getIdTokenClient");
  console.log("🔐 Getting request headers...");
  const headers = await withTimeout(client.getRequestHeaders(), AUTH_TIMEOUT_MS, "Google Auth getRequestHeaders");
  console.log("🔐 Authentication successful.");
  return headers as Record<string, string>;
}

function getLocalFileName(botIdentifier: string): string {
  return `inventory-${botIdentifier}.json`;
}

async function run(): Promise<number> {
  config();

  const {
    CONFIGURAMA_FOLDER_BASE_URL: configuramaBaseUrl,
    CONFIGURAMA_FOLDER_ENVIRONMENT: configuramaEnv = DEFAULT_ENVIRONMENT,
    CONFIGURAMA_FOLDER_PATH: configuramaFolderPath = "",
    BOT_IDENTIFIER: botIdentifier,
  } = process.env;

  if (!botIdentifier) {
    console.log("⏭️  BOT_IDENTIFIER not set, skipping inventory config fetch.");
    return 0;
  }

  const localFile = getLocalFileName(botIdentifier);

  // Helper to handle errors - fall back to local file if it exists.
  const handleError = (message: string): number => {
    if (existsSync(localFile)) {
      console.log(`⚠️  ${message}`);
      console.log(`📄 Local file "${localFile}" exists, continuing with existing config...`);
      return 0;
    }
    throw new Error(`${message} (and no local file "${localFile}" found)`);
  };

  if (!configuramaBaseUrl) {
    return handleError("CONFIGURAMA_FOLDER_BASE_URL environment variable is required");
  }

  const baseUrl = normalizeBaseUrl(configuramaBaseUrl);

  const configuramaFilePath = `${configuramaFolderPath}${localFile}`;

  console.log(`🤖 BOT_IDENTIFIER set to "${botIdentifier}", fetching ${localFile}`);
  console.log(`📂 Configurama: ${baseUrl} (environment: ${configuramaEnv}, path: ${configuramaFilePath})`);

  try {
    const headers = await getIdTokenHeaders(baseUrl);

    const url = `${baseUrl}/config?environment=${encodeURIComponent(configuramaEnv)}&filename=${encodeURIComponent(configuramaFilePath)}`;
    console.log(`📥 Fetching ${configuramaFilePath} from Configurama...`);

    const fileContent = await fetchWithRetry(url, headers);
    const jsonData = JSON.parse(fileContent);

    await writeFile(localFile, JSON.stringify(jsonData, null, 2));

    console.log(`✅ Successfully saved ${localFile}`);
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
  run()
    .then((result: number) => {
      process.exitCode = result;
    })
    .catch((error) => {
      console.error("❌ Process exited with error:", error.message);
      process.exitCode = 127;
    });
}
