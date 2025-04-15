import {
  ethers,
  retrieveSignerFromCLIArgs,
  getProvider,
  ERC20,
  ZERO_ADDRESS,
  toBN,
  getGasPrice,
  toGWei,
} from "../src/utils";
import { askYesNoQuestion } from "./utils";
import minimist from "minimist";
const args = minimist(process.argv.slice(2), {
  string: ["token", "to", "amount", "chainId", "nonce", "maxFeePerGas", "maxPriorityFeePerGas"],
});

// Example run:
// ts-node ./scripts/sendTokens.ts
// \ --token 0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48
// \ --amount 350000000000 --to 0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48
// \ --chainId 1
// \ --wallet gckms
// \ --keys bot1

// Example run to clear up a stuck nonce with a maxFeePerGas of 1 Gwei and a maxPriorityFeePerGas of 2 Gwei
// ts-node ./scripts/sendTokens.ts
// \ --token 0x
// \ --amount 0 --to <self-EOA>
// \ --chainId 1868
// \ --nonce 100
// \ --maxFeePerGas 1
// \ --maxPriorityFeePerGas 2
// \ --wallet gckms
// \ --keys bot4

export async function run(): Promise<void> {
  console.log("Executing Token sender 💸");
  if (!Object.keys(args).includes("token")) {
    throw new Error("Define `token` as the address of the token to send");
  }
  if (!Object.keys(args).includes("amount")) {
    throw new Error("Define `amount` as how much you want to send");
  }
  if (!Object.keys(args).includes("to")) {
    throw new Error("Define `to` as where you want to send funds to");
  }
  if (!Object.keys(args).includes("chainId")) {
    throw new Error("Define `chainId` as the chain you want to connect on");
  }
  const baseSigner = await retrieveSignerFromCLIArgs();
  const signerAddr = await baseSigner.getAddress();
  const connectedSigner = baseSigner.connect(await getProvider(Number(args.chainId)));
  console.log("Connected to account", signerAddr);
  const recipient = args.to;
  const token = args.token;
  if (!ethers.utils.isAddress(recipient)) {
    throw new Error("invalid addresses");
  }
  const nonce = args.nonce ? Number(args.nonce) : undefined;
  const maxFeePerGas = args.maxFeePerGas ? toGWei(args.maxFeePerGas) : undefined;
  const maxPriorityFeePerGas = args.maxFeePerGas ? toGWei(args.maxFeePerGas) : undefined;
  const gas =
    maxFeePerGas && maxPriorityFeePerGas
      ? { maxFeePerGas, maxPriorityFeePerGas }
      : await getGasPrice(connectedSigner.provider);
  console.log(
    `Submitting txn with maxFeePerGas ${gas.maxFeePerGas.toString()} and priority fee ${gas.maxPriorityFeePerGas.toString()} with overridden nonce ${nonce}`
  );
  // Send ETH
  if (token === ZERO_ADDRESS || token === "0x") {
    const amountFromWei = ethers.utils.formatUnits(args.amount, 18);
    console.log(`Send ETH with amount ${amountFromWei} tokens to ${recipient} on chain ${args.chainId}`);
    if (!(await askYesNoQuestion("\nConfirm that you want to execute this transaction?"))) {
      return;
    }
    console.log("sending...");
    const tx = await connectedSigner.sendTransaction({ to: recipient, value: toBN(args.amount), nonce, ...gas });
    const receipt = await tx.wait();
    console.log("Transaction hash:", receipt.transactionHash);
  }
  // Send ERC20
  else {
    const erc20 = new ethers.Contract(token, ERC20.abi, connectedSigner);
    const decimals = Number(await erc20.decimals());
    const symbol = await erc20.symbol();
    const amountFromWei = ethers.utils.formatUnits(args.amount, decimals);
    // Check the user is ok with the info provided. else abort.
    console.log(`Send ${symbol} with amount ${amountFromWei} tokens to ${recipient} on chain ${args.chainId}`);
    if (!(await askYesNoQuestion("\nConfirm that you want to execute this transaction?"))) {
      return;
    }
    console.log("sending...");
    const tx = await erc20.transfer(recipient, args.amount, { nonce, ...gas });

    const receipt = await tx.wait();
    console.log("Transaction hash:", receipt.transactionHash);
  }
}

if (require.main === module) {
  run()
    .then(async () => {
      // eslint-disable-next-line no-process-exit
      process.exit(0);
    })
    .catch(async (error) => {
      console.error("Process exited with", error);
      // eslint-disable-next-line no-process-exit
      process.exit(1);
    });
}
