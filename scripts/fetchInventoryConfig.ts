import { writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { config } from "dotenv";
import axios from "axios";

interface GitHubFileResponse {
  content: string;
  encoding: string;
  sha: string;
  size: number;
  url: string;
}

async function fetchWithRetry(
  url: string,
  headers: { Authorization: string; Accept: string },
  retries = 3,
  delayMs = 1000
): Promise<GitHubFileResponse> {
  for (let i = 0; i < retries; i++) {
    try {
      const response = await axios.get<GitHubFileResponse>(url, { headers });
      return response.data;
    } catch (error) {
      if (i === retries - 1) {
        throw error;
      }
      console.log(`⚠️  Request failed (attempt ${i + 1}/${retries}). Retrying in ${delayMs}ms...`);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  throw new Error("Failed to fetch file from GitHub");
}

async function fetchFileFromGitHub(
  owner: string,
  repo: string,
  folderName: string | undefined,
  fileName: string,
  token: string,
  branch = "master"
): Promise<string> {
  const filePath = folderName ? `${folderName}/${fileName}` : fileName;
  const url = `https://api.github.com/repos/${owner}/${repo}/contents/${filePath}?ref=${branch}`;
  const headers = {
    Authorization: `token ${token}`,
    Accept: "application/vnd.github.v3+json",
  };

  const response = await fetchWithRetry(url, headers);

  // GitHub API returns base64 encoded content
  const content = Buffer.from(response.content, "base64").toString("utf-8");
  return content;
}

function getLocalFileName(botIdentifier: string): string {
  return `inventory-${botIdentifier}.json`;
}
async function fetchAndWriteFile(
  owner: string,
  repo: string,
  folderName: string | undefined,
  fileName: string,
  token: string,
  branch: string
): Promise<void> {
  console.log(`📥 Fetching ${fileName}...`);

  const fileContent = await fetchFileFromGitHub(owner, repo, folderName, fileName, token, branch);

  // Parse JSON to validate it's valid JSON
  const jsonData = JSON.parse(fileContent);

  // Write to local file with same name
  await writeFile(fileName, JSON.stringify(jsonData, null, 2));

  console.log(`✅ Successfully saved ${fileName}`);
}

function parseFilePaths(filePaths: string): string[] {
  // Support comma-separated or JSON array format
  if (filePaths.startsWith("[")) {
    return JSON.parse(filePaths) as string[];
  }
  return filePaths.split(",").map((f) => f.trim());
}

async function run(): Promise<number> {
  config(); // Load .env file

  // Get configuration from environment variables
  const githubToken = process.env.GITHUB_TOKEN;
  const githubOwner = process.env.GITHUB_REPO_OWNER;
  const githubRepo = process.env.GITHUB_REPO_NAME;
  const githubFilePaths = process.env.GITHUB_FILE_PATHS;
  const githubFolderName = process.env.GITHUB_FOLDER_NAME || "serverless-bots";
  const githubBranch = process.env.GITHUB_BRANCH || "master";
  const botIdentifier = process.env.BOT_IDENTIFIER;

  // Helper to handle errors based on whether botIdentifier is set and local file exists
  const handleError = (message: string): number => {
    if (botIdentifier) {
      const localFile = getLocalFileName(botIdentifier);
      if (existsSync(localFile)) {
        console.log(`⚠️  ${message}`);
        console.log(`📄 Local file "${localFile}" exists, continuing with existing config...`);
        return 0;
      }
      // Local file doesn't exist, must throw
      throw new Error(`${message} (and no local file "${localFile}" found)`);
    }
    throw new Error(message);
  };

  // Validate required environment variables
  if (!githubToken) {
    return handleError("GITHUB_TOKEN environment variable is required");
  }
  if (!githubOwner) {
    return handleError("GITHUB_REPO_OWNER environment variable is required");
  }
  if (!githubRepo) {
    return handleError("GITHUB_REPO_NAME environment variable is required");
  }

  // Determine which files to fetch based on BOT_IDENTIFIER or GITHUB_FILE_PATHS
  let filesToFetch: string[];

  if (botIdentifier) {
    // If BOT_IDENTIFIER is set, fetch only that file (no need for GITHUB_FILE_PATHS)
    const targetFile = getLocalFileName(botIdentifier);
    filesToFetch = [targetFile];
    console.log(`🤖 BOT_IDENTIFIER set to "${botIdentifier}", fetching ${targetFile}`);
  } else {
    // No BOT_IDENTIFIER, require GITHUB_FILE_PATHS
    if (!githubFilePaths) {
      throw new Error("Either BOT_IDENTIFIER or GITHUB_FILE_PATHS environment variable is required");
    }
    filesToFetch = parseFilePaths(githubFilePaths);
    console.log(`📦 Fetching ${filesToFetch.length} file(s): ${filesToFetch.join(", ")}`);
  }

  console.log(`📂 Repository: ${githubOwner}/${githubRepo} (branch: ${githubBranch})`);

  try {
    await Promise.all(
      filesToFetch.map((fileName) =>
        fetchAndWriteFile(githubOwner, githubRepo, githubFolderName, fileName, githubToken, githubBranch)
      )
    );

    console.log("\n✅ All files fetched successfully!");
    return 0;
  } catch (error) {
    const errorMessage = getErrorMessage(error);
    return handleError(`Failed to fetch inventory config: ${errorMessage}`);
  }
}

function getErrorMessage(error: unknown): string {
  if (axios.isAxiosError(error)) {
    if (error.response?.status === 404) {
      return "File not found in repository";
    } else if (error.response?.status === 401 || error.response?.status === 403) {
      return "Authentication failed. Check your GITHUB_TOKEN and repository access.";
    } else {
      return `GitHub API error: ${error.response?.status} - ${error.message}`;
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
      // eslint-disable-next-line no-process-exit
      process.exit(result);
    })
    .catch((error) => {
      console.error("❌ Process exited with error:", error.message);
      // eslint-disable-next-line no-process-exit
      process.exit(127);
    });
}
