import { JussiPutGraphBundleRequest } from "./types";

const DEFAULT_JUSSI_API_TIMEOUT_MS = 30_000;

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
    const response = await fetch(url.toString(), {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        ...(this.apiToken ? { Authorization: `Bearer ${this.apiToken}` } : {}),
      },
      body: JSON.stringify(bundle),
      signal: AbortSignal.timeout(this.timeoutMs),
    });

    if (!response.ok) {
      const responseBody = await response.text().catch(() => "");
      const bodySnippet = responseBody ? `: ${responseBody.slice(0, 500)}` : "";
      throw new Error(`PUT ${url} failed with status ${response.status}${bodySnippet}`);
    }
  }
}
