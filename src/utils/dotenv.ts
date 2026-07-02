import { config } from "dotenv";

// Sanctioned bootstrap path. Imported as a side effect by `src/utils/index.ts` so that anything
// importing from the utils barrel transitively loads `.env` — bots, scripts, and ad-hoc tooling
// all pick this up without per-entry-point boilerplate. Tests opt out via `RELAYER_TEST=true`
// (set by the `test` / `test:parallel` package.json scripts) to keep the test env hermetic.
const isTest = (): boolean => process.env.RELAYER_TEST === "true";

if (!isTest()) {
  config();
}
