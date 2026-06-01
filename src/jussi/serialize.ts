import { createHash } from "node:crypto";
import { BigNumber } from "../utils";
import {
  buildJussiGraphBundleJson,
  buildJussiGraphEnvelope,
  buildJussiGraphId,
  buildJussiGraphJson,
  buildJussiRateLimitBucketsJson,
} from "./GraphBuilder";
import { JussiPutGraphBundleRequest } from "./types";

export {
  buildJussiGraphBundleJson,
  buildJussiGraphEnvelope,
  buildJussiGraphId,
  buildJussiGraphJson,
  buildJussiRateLimitBucketsJson,
};

export function canonicalizeJson(value: unknown): unknown {
  if (BigNumber.isBigNumber(value)) {
    return value.toString();
  }
  if (Array.isArray(value)) {
    return value.map(canonicalizeJson);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, objectValue]) => objectValue !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, objectValue]) => [key, canonicalizeJson(objectValue)])
    );
  }
  return value;
}

export function stableJsonStringify(value: unknown): string {
  return JSON.stringify(canonicalizeJson(value));
}

export function sha256StableJson(value: unknown): string {
  return createHash("sha256").update(stableJsonStringify(value)).digest("hex");
}

export function bundleHash(bundle: JussiPutGraphBundleRequest): string {
  return sha256StableJson(bundle);
}
