import { MonitorConfig } from "../monitor/MonitorConfig";
import { ProcessEnv } from "../common";

export class BalanceTrackerConfig extends MonitorConfig {
  readonly spreadsheetId: string;
  readonly sheetsCredentials: string | undefined;
  readonly sheetsWriteEnabled: boolean;

  constructor(env: ProcessEnv) {
    // Force report mode on so the Monitor's balance computation paths work.
    super({ ...env, MONITOR_REPORT_ENABLED: "true" });

    const { GOOGLE_SHEETS_SPREADSHEET_ID, GOOGLE_SHEETS_CREDENTIALS, SHEETS_WRITE_ENABLED } = env;

    if (!GOOGLE_SHEETS_SPREADSHEET_ID) {
      throw new Error("GOOGLE_SHEETS_SPREADSHEET_ID is required");
    }

    this.spreadsheetId = GOOGLE_SHEETS_SPREADSHEET_ID;
    this.sheetsCredentials = GOOGLE_SHEETS_CREDENTIALS;
    this.sheetsWriteEnabled = SHEETS_WRITE_ENABLED !== "false";
  }
}
