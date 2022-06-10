import { ethers, getSigner, getProvider, ERC20, getDeployedContract, toWei, runTransaction } from "../src/utils";
import { delay, Logger } from "@uma/financial-templates-lib";

import { askYesNoQuestion } from "./utils";
const args = require("minimist")(process.argv.slice(2), {
  string: ["token", "to", "amount"],
  number: ["chainId"],
});

// Example run:
// ts-node ./scripts/sendTokens.ts
// \ --token 0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48
// \ --amount 350000000000 --to 0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48
// \ --chainId 1
// \ --wallet gckms
// \ --keys bot1

export async function run(): Promise<void> {
  console.log("Executing Token depositor 💸");
  const chains = {
    10: [
      "0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1",
      "0x4200000000000000000000000000000000000006",
      "0x7F5c764cBc14f9669B88837ca1490cCa17c31607",
      "0x68f180fcCe6836688e9084f035309E29Bf0A2095",
    ],
    137: [
      "0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619",
      "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174",
      "0x8f3Cf7ad23Cd3CaDbD9735AFf958023239c6A063",
      "0x1BFD67037B42Cf73acF2047067bd4F2C47D9BfD6",
    ],
    288: [
      "0xf74195Bb8a5cf652411867c5C2C5b8C2a402be35",
      "0x66a2a913e447d6b4bf33efbec43aaef87890fbbc",
      "0xDeadDeAddeAddEAddeadDEaDDEAdDeaDDeAD0000",
      "0xdc0486f8bf31DF57a952bcd3c1d3e166e3d9eC8b",
    ],
    42161: [
      "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1",
      "0xFF970A61A04b1cA14834A43f5dE4533eBDDB5CC8",
      "0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1",
      "0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f",
    ],
  };
  const baseSigner = await getSigner();

  const logger = Logger;

  for (const _chainId of Object.keys(chains)) {
    const chainId = Number(_chainId);
    const connectedSigner = baseSigner.connect(getProvider(chainId));
    const address = connectedSigner.address;
    const spokePool = getDeployedContract("SpokePool", chainId, connectedSigner);
    const depositTimestamp = await spokePool.getCurrentTime();
    for (const tokenAddress of chains[_chainId]) {
      const token = new ethers.Contract(tokenAddress, ERC20.abi, connectedSigner);
      const [balance, allowance] = await Promise.all([
        token.balanceOf(address),
        token.allowance(address, spokePool.address),
      ]);
      console.log("Sending approval for", token.address, spokePool.address);
      console.log(balance.toString(), allowance.toString());
      if (balance.toString() != "0") {
        console.log("Send deposit...", token.address);

        const tx = await runTransaction(logger, spokePool, "deposit", [
          address,
          token.address,
          balance,
          1,
          toWei(0.1),
          depositTimestamp,
        ]);
        const receipt = await tx.wait();
        console.log(receipt.transactionHash);
      }
    }
  }
}

if (require.main === module) {
  run()
    .then(async () => {
      process.exit(0);
    })
    .catch(async (error) => {
      console.error("Process exited with", error);
      process.exit(1);
    });
}
