#!/usr/bin/env node
// Generates (or derives) Polymarket CLOB API credentials for an EOA.
//
// Usage:
//   PRIVATE_KEY=... node scripts/polymarket/generateApiCreds.mjs
//
// Notes:
// - This script uses your wallet locally. Never paste private keys into chat.
// - Output is intended to be copied into your local `.env` (do not commit it).

import { Wallet } from "ethers";

const host = process.env.POLYMARKET_HOST ?? "https://clob.polymarket.com";
const chainId = Number(process.env.POLYMARKET_CHAIN_ID ?? "137");

const pk = process.env.PRIVATE_KEY;
if (!pk) {
  console.error("Missing PRIVATE_KEY.");
  process.exit(1);
}

const wallet = new Wallet(pk);

const { ClobClient } = await import("@polymarket/clob-client");
const client = new ClobClient(host, chainId, wallet);
const creds = await client.createOrDeriveApiKey();

// The clob-client returns { apiKey, secret, passphrase }.
console.log(`POLYMARKET_API_KEY=${creds.key}`);
console.log(`POLYMARKET_API_SECRET=${creds.secret}`);
console.log(`POLYMARKET_API_PASSPHRASE=${creds.passphrase}`);
console.log(`POLYMARKET_HOST=${host}`);
