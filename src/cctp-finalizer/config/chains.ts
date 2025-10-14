import { ChainConfig } from "../types";

export const SUPPORTED_CHAINS: Record<number, ChainConfig> = {
  1: {
    chainId: 1,
    name: "Ethereum",
    rpcUrl: process.env.ETHEREUM_RPC_URL!,
    messageTransmitterAddress: "0x81D40F21F12A8F0E3252Bccb954D722d4c464B64",
    tokenMessengerAddress: "0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d",
    cctpDomain: 0,
  },
  10: {
    chainId: 10,
    name: "Optimism",
    rpcUrl: process.env.OPTIMISM_RPC_URL!,
    messageTransmitterAddress: "0x81D40F21F12A8F0E3252Bccb954D722d4c464B64",
    tokenMessengerAddress: "0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d",
    cctpDomain: 2,
  },
  137: {
    chainId: 137,
    name: "Polygon",
    rpcUrl: process.env.POLYGON_RPC_URL!,
    messageTransmitterAddress: "0x81D40F21F12A8F0E3252Bccb954D722d4c464B64",
    tokenMessengerAddress: "0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d",
    cctpDomain: 3,
  },
  42161: {
    chainId: 42161,
    name: "Arbitrum",
    rpcUrl: process.env.ARBITRUM_RPC_URL!,
    messageTransmitterAddress: "0x81D40F21F12A8F0E3252Bccb954D722d4c464B64",
    tokenMessengerAddress: "0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d",
    cctpDomain: 1,
  },
  8453: {
    chainId: 8453,
    name: "Base",
    rpcUrl: process.env.BASE_RPC_URL!,
    messageTransmitterAddress: "0x81D40F21F12A8F0E3252Bccb954D722d4c464B64",
    tokenMessengerAddress: "0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d",
    cctpDomain: 6,
  },
};

export function getChainConfig(chainId: number): ChainConfig {
  const config = SUPPORTED_CHAINS[chainId];
  if (!config) {
    throw new Error(`Unsupported chain ID: ${chainId}`);
  }
  return config;
}

export function validateEnvironmentVariables(): void {
  const requiredVars = [
    "PRIVATE_KEY",
    "ETHEREUM_RPC_URL",
    "OPTIMISM_RPC_URL",
    "ARBITRUM_RPC_URL",
    "POLYGON_RPC_URL",
    "BASE_RPC_URL",
  ];

  const missing = requiredVars.filter((varName) => !process.env[varName]);

  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(", ")}`);
  }
}
