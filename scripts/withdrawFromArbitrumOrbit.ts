// Submits a bridge from Arbitrum Orbit L2 to L1.
// For now, this script only supports WETH withdrawals on AlephZero.

import {
  ethers,
  retrieveSignerFromCLIArgs,
  getProvider,
  ERC20,
  TOKEN_SYMBOLS_MAP,
  assert,
  getL1TokenInfo,
  Contract,
  fromWei,
  blockExplorerLink,
  getNativeTokenSymbol,
} from "../src/utils";
import { CONTRACT_ADDRESSES } from "../src/common";
import { askYesNoQuestion } from "./utils";

import minimist from "minimist";

const cliArgs = ["amount", "chainId", "token"];
const args = minimist(process.argv.slice(2), {
  string: cliArgs,
});

// Example run:
// ts-node ./scripts/withdrawFromArbitrumOrbit.ts
// \ --amount 3000000000000000000
// \ --chainId 41455
// \ --token WETH
// \ --wallet gckms
// \ --keys bot1

export async function run(): Promise<void> {
  assert(
    cliArgs.every((cliArg) => Object.keys(args).includes(cliArg)),
    `Missing cliArg, expected: ${cliArgs}`
  );
  const baseSigner = await retrieveSignerFromCLIArgs();
  const signerAddr = await baseSigner.getAddress();
  const chainId = parseInt(args.chainId);
  const connectedSigner = baseSigner.connect(await getProvider(chainId));
  const l2Token = TOKEN_SYMBOLS_MAP[args.token]?.addresses[chainId];
  assert(l2Token, `${args.token} not found on chain ${chainId} in TOKEN_SYMBOLS_MAP`);
  const l1TokenInfo = getL1TokenInfo(l2Token, chainId);
  console.log("Fetched L1 token info:", l1TokenInfo);
  const amount = args.amount;
  const amountFromWei = ethers.utils.formatUnits(amount, l1TokenInfo.decimals);
  console.log(`Amount to bridge from chain ${chainId}: ${amountFromWei} ${l2Token}`);

  const erc20 = new Contract(l2Token, ERC20.abi, connectedSigner);
  const currentBalance = await erc20.balanceOf(signerAddr);
  const nativeTokenSymbol = getNativeTokenSymbol(chainId);
  const currentNativeBalance = await connectedSigner.getBalance();
  console.log(
    `Current ${l1TokenInfo.symbol} balance for account ${signerAddr}: ${fromWei(
      currentBalance,
      l1TokenInfo.decimals
    )} ${l2Token}`
  );
  console.log(
    `Current native ${nativeTokenSymbol} token balance for account ${signerAddr}: ${fromWei(currentNativeBalance, 18)}`
  );

  // Now, submit a withdrawal:
  let contract: Contract, functionName: string, functionArgs: any[];
  if (l1TokenInfo.symbol !== nativeTokenSymbol) {
    const arbErc20GatewayObj = CONTRACT_ADDRESSES[chainId].erc20Gateway;
    contract = new Contract(arbErc20GatewayObj.address, arbErc20GatewayObj.abi, connectedSigner);
    functionName = "outboundTransfer";
    functionArgs = [
      l1TokenInfo.address, // l1Token
      signerAddr, // to
      amount, // amount
      "0x", // data
    ];

    console.log(
      `Submitting ${functionName} on the Arbitrum ERC20 gateway router @ ${contract.address} with the following args: `,
      ...functionArgs
    );
  } else {
    const arbSys = CONTRACT_ADDRESSES[chainId].arbSys;
    contract = new Contract(arbSys.address, arbSys.abi, connectedSigner);
    functionName = "withdrawEth";
    functionArgs = [
      signerAddr, // to
      { value: amount },
    ];
    console.log(
      `Submitting ${functionName} on the ArbSys contract @ ${contract.address} with the following args: `,
      ...functionArgs
    );
  }

  if (!(await askYesNoQuestion("\nDo you want to proceed?"))) {
    return;
  }
  const withdrawal = await contract[functionName](...functionArgs);
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
