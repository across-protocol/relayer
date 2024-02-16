import { number, object, optional, string } from "superstruct";

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

export type ArweaveGatewayInterface = {
  url: string;
  protocol: string;
  port: number;
};

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

export const ArweaveGatewayInterfaceSS = object({
  url: string(),
  protocol: string(),
  port: number(),
});
