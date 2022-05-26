import { delay, ethers, getSigner, getProvider, ERC20 } from "../src/utils";
import { askYesNoQuestion } from "./utils";
const args = require("minimist")(process.argv.slice(2));

export async function run(): Promise<void> {
  console.log("Executing Token sender 💸");
  if (!Object.keys(args).includes("token")) throw new Error("Define `token` as the address of the token to send");
  if (!Object.keys(args).includes("amount")) throw new Error("Define `amount` as how much you want to send");
  if (!Object.keys(args).includes("to")) throw new Error("Define `to` as where you want to send funds to");
  if (!Object.keys(args).includes("chainId")) throw new Error("Define `chainId` as the chain you want to connect on");
  const baseSigner = await getSigner();
  const connectedSigner = baseSigner.connect(getProvider(Number(args.chainId)));
  const usdc = new ethers.Contract(args.token, ERC20.abi, connectedSigner);
  // Check the user is ok with the info provided. else abort.
  console.log(`end ${args.token} with amount ${args.amount} tokens to ${args.to} on chain ${args.chainId}`);
  if (!(await askYesNoQuestion("\n2. Does this match your expectations?"))) process.exit(0);
  console.log("sending...");
  const tx = await usdc.transfer(args.to, args.amount);
  const receipt = await tx.wait();
  console.log("Transaction hash:", receipt.transactionHash);
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
