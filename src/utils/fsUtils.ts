import * as fs from "fs/promises";
import { typeguards } from "@across-protocol/sdk-v2";

export async function readFile(fileName: string): Promise<string> {
  try {
    return await fs.readFile(fileName, { encoding: "utf8" });
  } catch (err) {
    // @dev fs methods can return errors that are not Error objects (i.e. errno).
    const msg = typeguards.isError(err) ? err.message : (err as Record<string, unknown>)?.code;
    throw new Error(`Unable to read ${fileName} (${msg ?? "unknown error"})`);
  }
}
