import { createHash } from "node:crypto";
import { BigNumber } from "../utils/BNUtils";
import type {
  BuiltJussiGraph,
  JussiGraphBundleJson,
  JussiGraphEnvelope,
  JussiGraphJson,
  JussiGraphRateLimitBucketsJson,
  JussiPutGraphBundleRequest,
} from "./types";

export function buildJussiGraphId(now = new Date()): string {
  return `usdc-usdt-weth-${now
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z")}`;
}

export function buildJussiGraphEnvelope(graph: BuiltJussiGraph): JussiGraphEnvelope {
  return {
    graph_id: graph.graphId,
    payload: buildJussiGraphBundleJson(graph),
  };
}

export function buildJussiGraphJson(graph: BuiltJussiGraph): JussiGraphJson {
  return graph.payload;
}

export function buildJussiGraphBundleJson(graph: BuiltJussiGraph): JussiGraphBundleJson {
  return {
    graph: buildJussiGraphJson(graph),
    rate_limit_buckets: graph.rate_limit_buckets,
  };
}

export function buildJussiRateLimitBucketsJson(graph: BuiltJussiGraph): JussiGraphRateLimitBucketsJson {
  return {
    rate_limit_buckets: graph.rate_limit_buckets,
  };
}

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
