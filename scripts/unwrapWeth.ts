import { ethers, getSigner, getProvider, WETH9, toBN } from "../src/utils";
import { askYesNoQuestion } from "./utils";
const args = require("minimist")(process.argv.slice(2), {
  string: ["amount"],
  number: ["chainId"]
});

// Example run:
// ts-node ./scripts/unwrapWeth.ts
// \ --amount 3000000000000000000
// \ --chainId 1
// \ --wallet gckms
// \ --keys bot1

const WETH_ADDRESSES = {
    1: "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2",
    10: "0x4200000000000000000000000000000000000006",
    42161: "0x82af49447d8a07e3bd95bd0d56f35241523fbab1",
    137: "0x7ceb23fd6bc0add59e62ac25578270cff1b9f619",
    288: "0xDeadDeAddeAddEAddeadDEaDDEAdDeaDDeAD0000"
}

export async function run(): Promise<void> {
    console.log("Unwrapping WETH 🎊");
    if (!Object.keys(args).includes("chainId")) throw new Error("Define `chainId` as the chain you want to connect on");
    if (!Object.keys(args).includes("amount")) throw new Error("Define `amount` as how much you want to unwrap");
    const baseSigner = await getSigner();
    const connectedSigner = baseSigner.connect(getProvider(Number(args.chainId)));
    const token = WETH_ADDRESSES[Number(args.chainId)];

    const weth = new ethers.Contract(token, WETH9.abi, connectedSigner);
    const decimals = 18;
    const amountFromWei = ethers.utils.formatUnits(args.amount, decimals);
    const currentBalance = ethers.utils.formatUnits(await weth.balanceOf(baseSigner.address), decimals)
    console.log(`Current WETH balance for account ${baseSigner.address} on Mainnet: ${currentBalance}`);
    if ((await weth.balanceOf(baseSigner.address)).lt(toBN(args.amount))) {
        console.log(`WETH balance < ${amountFromWei}, exiting`)
        return;
    }
    // Check the user is ok with the info provided. else abort.
    console.log(`Unwrap ${amountFromWei} WETH`);
    if (!(await askYesNoQuestion("\nConfirm that you want to execute this transaction?"))) process.exit(0);
    console.log("sending...");
    const tx = await weth.withdraw(args.amount);
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
