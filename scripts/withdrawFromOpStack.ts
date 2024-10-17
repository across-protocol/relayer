// Submits a bridge from OpStack L2 to L1.
// For now, this script only supports ETH withdrawals.

import {
  ethers,
  retrieveSignerFromCLIArgs,
  getProvider,
  ERC20,
  WETH9,
  TOKEN_SYMBOLS_MAP,
  assert,
  getL1TokenInfo,
  Contract,
  fromWei,
  blockExplorerLink,
} from "../src/utils";
import { CONTRACT_ADDRESSES } from "../src/common";
import { askYesNoQuestion } from "./utils";

import minimist from "minimist";

const cliArgs = ["amount", "chainId"];
const args = minimist(process.argv.slice(2), {
  string: cliArgs,
});

// Example run:
// ts-node ./scripts/withdrawFromOpStack.ts
// \ --amount 3000000000000000000
// \ --chainId 1135
// \ --wallet gckms
// \ --keys bot1

export async function run(): Promise<void> {
  assert(
    cliArgs.every((cliArg) => Object.keys(args).includes(cliArg)),
    `Missing cliArg, expected: ${cliArgs}`
  );
  const baseSigner = await retrieveSignerFromCLIArgs();
  const signerAddr = await baseSigner.getAddress();
  const chainId = Number(args.chainId);
  const connectedSigner = baseSigner.connect(await getProvider(chainId));
  const l2Token = TOKEN_SYMBOLS_MAP.WETH?.addresses[chainId];
  assert(l2Token, `WETH not found on chain ${chainId} in TOKEN_SYMBOLS_MAP`);
  const l1TokenInfo = getL1TokenInfo(l2Token, chainId);
  console.log("Fetched L1 token info:", l1TokenInfo);
  assert(l1TokenInfo.symbol === "ETH", "Only WETH withdrawals are supported for now.");
  const amount = args.amount;
  const amountFromWei = ethers.utils.formatUnits(amount, l1TokenInfo.decimals);
  console.log(`Amount to bridge from chain ${chainId}: ${amountFromWei} ${l2Token}`);

  const erc20 = new Contract(l2Token, ERC20.abi, connectedSigner);
  const currentBalance = await erc20.balanceOf(signerAddr);
  const currentEthBalance = await connectedSigner.getBalance();
  console.log(
    `Current WETH balance for account ${signerAddr}: ${fromWei(currentBalance, l1TokenInfo.decimals)} ${l2Token}`
  );
  console.log(`Current ETH balance for account ${signerAddr}: ${fromWei(currentEthBalance, l1TokenInfo.decimals)}`);

  // First offer user option to unwrap WETH into ETH.
  const weth = new Contract(l2Token, WETH9.abi, connectedSigner);
  if (await askYesNoQuestion(`\nUnwrap ${amount} of WETH @ ${weth.address}?`)) {
    const unwrap = await weth.withdraw(amount);
    console.log(`Submitted transaction: ${blockExplorerLink(unwrap.hash, chainId)}.`);
    const receipt = await unwrap.wait();
    console.log("Unwrap complete...", receipt);
  }

  // Now, submit a withdrawal:
  const ovmStandardBridgeObj = CONTRACT_ADDRESSES[chainId].ovmStandardBridge;
  assert(CONTRACT_ADDRESSES[chainId].ovmStandardBridge, "ovmStandardBridge for chain not found in CONTRACT_ADDRESSES");
  const ovmStandardBridge = new Contract(ovmStandardBridgeObj.address, ovmStandardBridgeObj.abi, connectedSigner);
  const bridgeETHToArgs = [
    signerAddr, // to
    200_000, // minGasLimit
    "0x", // extraData
    { value: amount }, // msg.value
  ];

  console.log(
    `Submitting bridgeETHTo on the OVM standard bridge @ ${ovmStandardBridge.address} with the following args: `,
    ...bridgeETHToArgs
  );
  if (!(await askYesNoQuestion("\nDo you want to proceed?"))) {
    return;
  }
  const withdrawal = await ovmStandardBridge.bridgeETHTo(...bridgeETHToArgs);
  console.log(`Submitted withdrawal: ${blockExplorerLink(withdrawal.hash, chainId)}.`);
  const receipt = await withdrawal.wait();
  console.log("Receipt", receipt);
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
