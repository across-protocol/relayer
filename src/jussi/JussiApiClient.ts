import { JussiPutGraphBundleRequest } from "./types";

const DEFAULT_JUSSI_API_TIMEOUT_MS = 30_000;

export async function putJsonWithTimeout(
  url: string,
  body: unknown,
  headers: Record<string, string> = {},
  timeoutMs = DEFAULT_JUSSI_API_TIMEOUT_MS
): Promise<void> {
  const response = await fetch(url, {
    method: "PUT",
    headers: {
      "content-type": "application/json",
      ...headers,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (!response.ok) {
    const responseBody = await response.text().catch(() => "");
    const bodySnippet = responseBody ? `: ${responseBody.slice(0, 500)}` : "";
    throw new Error(`PUT ${url} failed with status ${response.status}${bodySnippet}`);
  }
}

export class JussiApiClient {
  constructor(
    private readonly apiUrl: string,
    private readonly apiToken?: string,
    private readonly timeoutMs = DEFAULT_JUSSI_API_TIMEOUT_MS
  ) {}

  async putGraphBundle(graphId: string, bundle: JussiPutGraphBundleRequest): Promise<void> {
    const url = new URL(
      `graph_bundles/${encodeURIComponent(graphId)}`,
      this.apiUrl.endsWith("/") ? this.apiUrl : `${this.apiUrl}/`
    );
    await putJsonWithTimeout(
      url.toString(),
      bundle,
      this.apiToken ? { Authorization: `Bearer ${this.apiToken}` } : {},
      this.timeoutMs
    );
  }
}
