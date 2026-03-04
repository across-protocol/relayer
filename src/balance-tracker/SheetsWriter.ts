import { GoogleAuth } from "google-auth-library";
import axios from "axios";
import { winston } from "../utils";

const SHEETS_API_BASE = "https://sheets.googleapis.com/v4/spreadsheets";
const SCOPES = ["https://www.googleapis.com/auth/spreadsheets"];

export class SheetsWriter {
  private readonly auth: GoogleAuth;
  private existingTabs: Set<string> = new Set();
  private tabHeaders: Map<string, string[]> = new Map();

  constructor(
    private readonly logger: winston.Logger,
    private readonly spreadsheetId: string,
    credentialsPath?: string
  ) {
    this.auth = new GoogleAuth({
      scopes: SCOPES,
      ...(credentialsPath ? { keyFile: credentialsPath } : {}),
    });
  }

  private async sheetsRequest(method: "get" | "post" | "put", path: string, data?: unknown, params?: Record<string, string>) {
    const client = await this.auth.getClient();
    const headers = await client.getRequestHeaders();
    const url = `${SHEETS_API_BASE}/${this.spreadsheetId}${path}`;
    return axios({ method, url, headers: { Authorization: headers.Authorization as string }, data, params });
  }

  private async ensureSheetTab(tabName: string): Promise<void> {
    if (this.existingTabs.has(tabName)) {
      return;
    }

    // Fetch existing sheet tabs.
    if (this.existingTabs.size === 0) {
      const { data } = await this.sheetsRequest("get", "", undefined, { fields: "sheets.properties.title" });
      for (const sheet of data.sheets ?? []) {
        this.existingTabs.add(sheet.properties.title);
      }
    }

    if (!this.existingTabs.has(tabName)) {
      await this.sheetsRequest("post", ":batchUpdate", {
        requests: [{ addSheet: { properties: { title: tabName } } }],
      });
      this.existingTabs.add(tabName);
      this.logger.debug({ at: "SheetsWriter", message: `Created tab "${tabName}"` });
    }
  }

  private async getOrWriteHeader(tabName: string, symbols: string[]): Promise<string[]> {
    // Check if we already know the header for this tab.
    let header = this.tabHeaders.get(tabName);
    if (header) {
      return header;
    }

    // Try to read the existing header row.
    try {
      const { data } = await this.sheetsRequest("get", `/values/${encodeTab(tabName)}!1:1`);
      if (data.values?.[0]?.length > 0) {
        header = data.values[0] as string[];
        this.tabHeaders.set(tabName, header);
        return header;
      }
    } catch {
      // No data yet.
    }

    // Write a new header.
    header = ["time", ...symbols];
    await this.sheetsRequest("put", `/values/${encodeTab(tabName)}!A1`, { values: [header] }, {
      valueInputOption: "RAW",
    });
    this.tabHeaders.set(tabName, header);
    return header;
  }

  async appendRow(tabName: string, symbols: string[], row: string[]): Promise<void> {
    await this.ensureSheetTab(tabName);

    const header = await this.getOrWriteHeader(tabName, symbols);

    // If new tokens appeared, expand the header.
    const headerSymbols = header.slice(1);
    const newSymbols = symbols.filter((s) => !headerSymbols.includes(s));
    if (newSymbols.length > 0) {
      header.push(...newSymbols);
      await this.sheetsRequest("put", `/values/${encodeTab(tabName)}!A1`, { values: [header] }, {
        valueInputOption: "RAW",
      });
      this.tabHeaders.set(tabName, header);
    }

    // Build the row aligned to the header columns.
    const time = row[0];
    const symbolToValue = new Map<string, string>();
    for (let i = 0; i < symbols.length; i++) {
      symbolToValue.set(symbols[i], row[i + 1]);
    }
    const alignedRow = [time, ...header.slice(1).map((s) => symbolToValue.get(s) ?? "")];

    await this.sheetsRequest("post", `/values/${encodeTab(tabName)}!A1:append`, { values: [alignedRow] }, {
      valueInputOption: "USER_ENTERED",
      insertDataOption: "INSERT_ROWS",
    });

    this.logger.debug({ at: "SheetsWriter", message: `Appended row to "${tabName}"` });
  }
}

function encodeTab(name: string): string {
  // Sheet names with special chars must be single-quoted in A1 notation.
  return `'${name.replace(/'/g, "''")}'`;
}
