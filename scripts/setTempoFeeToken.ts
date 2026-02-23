import { ethers, retrieveSignerFromCLIArgs, getProvider, CHAIN_IDs, Contract } from "../src/utils";
import minimist from "minimist";
const args = minimist(process.argv.slice(2), {
  string: ["token", "to", "amount", "chainId", "nonce", "maxFeePerGas", "maxPriorityFeePerGas"],
});

const FEE_MANAGER = "0xfeec000000000000000000000000000000000000";
const FEE_MANAGER_ABI = [
  {
    name: "setUserToken",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      {
        type: "address",
        name: "token",
      },
    ],
    outputs: [],
  },
];

// Example run:
// ts-node ./scripts/setTempoFeeToken.ts
// \ --token [fee_token]
// \ --wallet gckms
// \ --keys bot1

export async function run(): Promise<void> {
  const baseSigner = await retrieveSignerFromCLIArgs();
  const signerAddr = await baseSigner.getAddress();

  console.log(`Setting new fee token for account ${signerAddr}`);
  if (!Object.keys(args).includes("token")) {
    throw new Error("Define `token` as the address of the token to send");
  }

  const connectedSigner = baseSigner.connect(await getProvider(Number(CHAIN_IDs.TEMPO)));
  const newFeeToken = args.token;

  if (!ethers.utils.isAddress(newFeeToken)) {
    throw new Error("invalid fee token");
  }

  const feeManager = new Contract(FEE_MANAGER, FEE_MANAGER_ABI, connectedSigner);

  const tx = await feeManager.setUserToken(newFeeToken);
  const txReceipt = await tx.wait();

  console.log(
    `Set new fee token default ${newFeeToken} for address ${signerAddr}. Tx Hash: ${txReceipt.transactionHash}`
  );
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
