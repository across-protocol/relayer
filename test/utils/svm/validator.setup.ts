import {
  SvmSpokeClient,
  MulticallHandlerClient,
  MessageTransmitterClient,
  TokenMessengerMinterClient,
} from "@across-protocol/contracts";
import { Address } from "@solana/kit";
import { spawn } from "child_process";
import fs from "node:fs/promises";
import path from "node:path";
import * as tar from "tar";
import contractsPkg from "@across-protocol/contracts/package.json" assert { type: "json" };

// Helper function to get the @across-protocol/contracts version from the package.json
const getContractsVersion = (): string => {
  return `v${contractsPkg.version}`;
};

// Directory and file constants
const LEDGER_DIR = path.resolve(__dirname, "..", ".ledger");
const TARGET_DIR = path.resolve(__dirname, "..", "..", "..");
const SVM_SPOKE_SO_PATH = path.resolve(TARGET_DIR, "target", "deploy", "svm_spoke.so");
const MULTICALL_HANDLER_PATH = path.resolve(TARGET_DIR, "target", "deploy", "multicall_handler.so");
const MESSAGE_TRANSMITTER_CONFIG_OVERRIDE_PATH = path.resolve(__dirname, "accounts", "message_transmitter.json");
const TOKEN_MESSENGER_MINTER_CONFIG_OVERRIDE_PATH = path.resolve(__dirname, "accounts", "token_minter.json");
const BINARY_RELEASE_TAG = process.env.SVM_BINARY_RELEASE_TAG || getContractsVersion();
const BINARY_ARCHIVE_NAME = process.env.SVM_BINARY_ARCHIVE_NAME || "svm-verified-test-binaries.tar.gz";
const BINARY_DOWNLOAD_URL = `https://github.com/across-protocol/contracts/releases/download/${BINARY_RELEASE_TAG}/${BINARY_ARCHIVE_NAME}`;
const SAVED_ARCHIVE_NAME = `svm-verified-test-binaries.${BINARY_RELEASE_TAG}.tar.gz`;

/**
 * Download and save the SVM spoke test binaries if not already present.
 */
async function ensureBinaries(): Promise<void> {
  const archivePath = path.join(TARGET_DIR, SAVED_ARCHIVE_NAME);
  try {
    await fs.access(archivePath);
  } catch {
    const response = await fetch(BINARY_DOWNLOAD_URL);
    if (!response.ok) {
      throw new Error(`Failed to download binaries: ${response.status} ${response.statusText}`);
    }

    const blob = await response.blob();
    await fs.writeFile(archivePath, Buffer.from(await blob.arrayBuffer()));
  }

  await tar.x({ file: path.join(TARGET_DIR, SAVED_ARCHIVE_NAME), cwd: TARGET_DIR });
}

/**
 * Starts a local Solana test validator with the SVM spoke program loaded.
 * @param upgradeAuthority - The address authorized to upgrade the program
 */
export async function validatorSetup(upgradeAuthority: Address): Promise<void> {
  // Clean previous ledger state
  await fs.rm(LEDGER_DIR, { recursive: true, force: true });
  // Ensure target directory
  await fs.mkdir(TARGET_DIR, { recursive: true });

  // Prepare binaries
  await ensureBinaries();

  // Launch test validator
  const args = [
    "--upgradeable-program",
    SvmSpokeClient.SVM_SPOKE_PROGRAM_ADDRESS,
    SVM_SPOKE_SO_PATH,
    upgradeAuthority,
    "--upgradeable-program",
    MulticallHandlerClient.MULTICALL_HANDLER_PROGRAM_ADDRESS,
    MULTICALL_HANDLER_PATH,
    upgradeAuthority,
    "--clone-upgradeable-program",
    MessageTransmitterClient.MESSAGE_TRANSMITTER_PROGRAM_ADDRESS,
    "--clone-upgradeable-program",
    TokenMessengerMinterClient.TOKEN_MESSENGER_MINTER_PROGRAM_ADDRESS,
    "--account",
    "BWrwSWjbikT3H7qHAkUEbLmwDQoB4ZDJ4wcSEhSPTZCu",
    MESSAGE_TRANSMITTER_CONFIG_OVERRIDE_PATH,
    "--account",
    "DBD8hAwLDRQkTsu6EqviaYNGKPnsAMmQonxf7AH8ZcFY",
    TOKEN_MESSENGER_MINTER_CONFIG_OVERRIDE_PATH,
    "--clone",
    "Afgq3BHEfCE7d78D2XE9Bfyu2ieDqvE24xX8KDwreBms",
    "--clone",
    "Hazwi3jFQtLKc2ughi7HFXPkpDeso7DQaMR9Ks4afh3j",
    "--ledger",
    LEDGER_DIR,
    "--reset",
    "--url",
    "mainnet-beta",
  ];

  const proc = spawn("solana-test-validator", args, {
    stdio: ["ignore", "pipe", "pipe"],
  });

  // Wait until the validator is ready
  await new Promise<void>((resolve, reject) => {
    proc.stdout.on("data", (chunk: Buffer) => {
      const msg = chunk.toString();
      if (msg.includes("JSON RPC URL")) {
        resolve();
      }
    });
    proc.on("error", reject);
    proc.on("exit", (code) => reject(new Error(`Validator exited early with code ${code}`)));
  });

  // Store PID for teardown
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (global as any).__SOLANA_VALIDATOR_PID__ = proc.pid;
}

/**
 * Stops the running Solana test validator, if any.
 */
export function validatorTeardown(): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const pid = (global as any).__SOLANA_VALIDATOR_PID__;
  if (pid) {
    process.kill(pid);
  }
}
