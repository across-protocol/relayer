import { writeFile } from "node:fs/promises";
import { config } from "dotenv";
import axios from "axios";
import { GoogleAuth } from "google-auth-library";

const DEFAULT_OUTPUT_PATH = "inventoryConfig.json";
const DEFAULT_ENVIRONMENT = "prod";

type JsonValue = Record<string, unknown> | unknown[];

async function fetchWithRetry(
  url: string,
  headers: Record<string, string>,
  retries = 3,
  delayMs = 1000
): Promise<string> {
  for (let i = 0; i < retries; i++) {
    try {
      const response = await axios.get(url, { headers, responseType: "text" });
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

function extractInventoryConfig(parsed: JsonValue): Record<string, unknown> {
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    const asRecord = parsed as Record<string, unknown>;
    const nested = asRecord.RELAYER_INVENTORY_CONFIG;
    if (nested && typeof nested === "object" && !Array.isArray(nested)) {
      return nested as Record<string, unknown>;
    }
    return asRecord;
  }
  throw new Error("Inventory config must be a JSON object");
}

async function getIdTokenHeaders(audience: string): Promise<Record<string, string>> {
  const auth = new GoogleAuth();
  const client = await auth.getIdTokenClient(audience);
  const headers = await client.getRequestHeaders();
  return headers as Record<string, string>;
}

async function run(): Promise<number> {
  config(); // Load .env file

  const configuramaBaseUrl = process.env.CONFIGURAMA_BASE_URL;
  const configuramaEnv = process.env.CONFIGURAMA_ENV ?? DEFAULT_ENVIRONMENT;
  const configuramaFilePath = process.env.CONFIGURAMA_FILE_PATH;
  const outputPath = process.env.RELAYER_EXTERNAL_INVENTORY_CONFIG ?? DEFAULT_OUTPUT_PATH;

  if (!configuramaBaseUrl && !configuramaFilePath) {
    console.log("Skipping inventory config fetch: CONFIGURAMA_BASE_URL and CONFIGURAMA_FILE_PATH not set.");
    return 0;
  }
  if (!configuramaBaseUrl || !configuramaFilePath) {
    throw new Error("CONFIGURAMA_BASE_URL and CONFIGURAMA_FILE_PATH must both be set.");
  }

  const baseUrl = normalizeBaseUrl(configuramaBaseUrl);
  const url = `${baseUrl}/config?environment=${encodeURIComponent(configuramaEnv)}&filename=${encodeURIComponent(
    configuramaFilePath
  )}`;

  console.log(`Fetching inventory config from ${url}...`);

  try {
    const headers = await getIdTokenHeaders(baseUrl);
    const fileContent = await fetchWithRetry(url, headers);

    const parsed = JSON.parse(fileContent) as JsonValue;
    const inventoryConfig = extractInventoryConfig(parsed);

    await writeFile(outputPath, JSON.stringify(inventoryConfig, null, 2));

    console.log(`✅ Successfully fetched and saved to ${outputPath}`);
    return 0;
  } catch (error) {
    if (axios.isAxiosError(error)) {
      if (error.response?.status === 404) {
        throw new Error(`File not found: ${configuramaFilePath} in Configurama (${configuramaEnv})`);
      } else if (error.response?.status === 401 || error.response?.status === 403) {
        throw new Error("Authentication failed. Ensure ADC is configured to call the Configurama API.");
      } else {
        throw new Error(`Configurama API error: ${error.response?.status} - ${error.message}`);
      }
    }
    throw error;
  }
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
