import { writeFile } from "node:fs/promises";
import { config } from "dotenv";
import axios from "axios";

const OUTPUT_PATH = "inventoryConfig.json";

interface GitHubFileResponse {
  content: string;
  encoding: string;
  sha: string;
  size: number;
  url: string;
}

async function fetchFileFromGitHub(
  owner: string,
  repo: string,
  path: string,
  token: string,
  branch = "main"
): Promise<string> {
  const url = `https://api.github.com/repos/${owner}/${repo}/contents/${path}?ref=${branch}`;

  const response = await axios.get<GitHubFileResponse>(url, {
    headers: {
      Authorization: `token ${token}`,
      Accept: "application/vnd.github.v3+json",
    },
  });

  // GitHub API returns base64 encoded content
  const content = Buffer.from(response.data.content, "base64").toString("utf-8");
  return content;
}

async function run(): Promise<number> {
  config(); // Load .env file

  // Get configuration from environment variables
  const githubToken = process.env.GITHUB_TOKEN;
  const githubOwner = process.env.GITHUB_REPO_OWNER;
  const githubRepo = process.env.GITHUB_REPO_NAME;
  const githubFilePath = process.env.GITHUB_FILE_PATH;
  const githubBranch = process.env.GITHUB_BRANCH || "main";

  // Validate required environment variables
  if (!githubToken) {
    throw new Error("GITHUB_TOKEN environment variable is required");
  }
  if (!githubOwner) {
    throw new Error("GITHUB_REPO_OWNER environment variable is required");
  }
  if (!githubRepo) {
    throw new Error("GITHUB_REPO_NAME environment variable is required");
  }
  if (!githubFilePath) {
    throw new Error("GITHUB_FILE_PATH environment variable is required");
  }

  console.log(`Fetching ${githubFilePath} from ${githubOwner}/${githubRepo} (branch: ${githubBranch})...`);

  try {
    // Fetch the file content from GitHub
    const fileContent = await fetchFileFromGitHub(githubOwner, githubRepo, githubFilePath, githubToken, githubBranch);

    // Parse JSON to validate it's valid JSON
    const jsonData = JSON.parse(fileContent);

    // Write to output file
    await writeFile(OUTPUT_PATH, JSON.stringify(jsonData, null, 2));

    console.log(`✅ Successfully fetched and saved to ${OUTPUT_PATH}`);
    return 0;
  } catch (error) {
    if (axios.isAxiosError(error)) {
      if (error.response?.status === 404) {
        throw new Error(`File not found: ${githubFilePath} in ${githubOwner}/${githubRepo}`);
      } else if (error.response?.status === 401 || error.response?.status === 403) {
        throw new Error(
          `Authentication failed. Check your GITHUB_TOKEN and ensure it has access to ${githubOwner}/${githubRepo}`
        );
      } else {
        throw new Error(`GitHub API error: ${error.response?.status} - ${error.message}`);
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
