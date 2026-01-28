import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";

/**
 * Validates inventory config JSON files exist and are valid JSON
 * Files are to be fetched in a prior build step and passed as args
 */

async function validateJsonFile(filePath: string): Promise<void> {
  if (!existsSync(filePath)) {
    throw new Error(`File not found: ${filePath}`);
  }

  const content = await readFile(filePath, "utf-8");

  try {
    const parsed = JSON.parse(content);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error(`Invalid inventory config: ${filePath} must be a JSON object`);
    }
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error(`Invalid JSON in ${filePath}: ${error.message}`);
    }
    throw error;
  }
}

async function run(): Promise<number> {
  const filePaths = process.argv.slice(2);

  if (filePaths.length === 0) {
    console.log("No inventory config files specified. Skipping validation.");
    return 0;
  }

  console.log(`Validating ${filePaths.length} inventory config file(s)...`);

  for (const filePath of filePaths) {
    await validateJsonFile(filePath);
    console.log(`Validated: ${filePath}`);
  }

  console.log("All inventory config files validated successfully.");
  return 0;
}

if (require.main === module) {
  run()
    .then((code) => process.exit(code))
    .catch((error) => {
      console.error(`Error: ${error.message}`);
      process.exit(1);
    });
}
