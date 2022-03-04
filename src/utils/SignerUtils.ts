import { ethers } from "ethers";

export function getSigner(provider?: ethers.providers.Provider) {
  console.log("process.argv.includes", process.argv);
  if (process.argv.includes("--wallet") && process.argv.includes("mnemonic")) {
    const mnemonic = process.env.MNEMONIC;
    if (!mnemonic) throw new Error(`Wallet mnemonic selected but no MNEMONIC env set!`);
    return ethers.Wallet.fromMnemonic(mnemonic);
  }
  throw new Error("No wallet configuration set! use --wallet mnemonic");
}
