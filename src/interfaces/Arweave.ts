import { number, object, optional, string } from "superstruct";
import { caching } from "@across-protocol/sdk";

export type ArweaveWalletJWKInterface = {
  kty: string;
  e: string;
  n: string;
  d?: string;
  p?: string;
  q?: string;
  dp?: string;
  dq?: string;
  qi?: string;
};

export type ArweaveGatewayConfig = caching.ArweaveGatewayConfig;

export const ArweaveWalletJWKInterfaceSS = object({
  kty: string(),
  e: string(),
  n: string(),
  d: optional(string()),
  p: optional(string()),
  q: optional(string()),
  dp: optional(string()),
  dq: optional(string()),
  qi: optional(string()),
});

export const ArweaveGatewayConfigSS = object({
  host: string(),
  protocol: optional(string()),
  port: optional(number()),
});
