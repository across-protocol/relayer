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
  CHAIN_IDs,
  ZERO_ADDRESS,
} from "../src/utils";
import { CONTRACT_ADDRESSES } from "../src/common";
import { askYesNoQuestion, getOvmSpokePoolContract } from "./utils";

import minimist from "minimist";

const cliArgs = ["amount", "chainId", "token"];
const args = minimist(process.argv.slice(2), {
  string: cliArgs,
});

// Example run:
// ts-node ./scripts/withdrawFromOpStack.ts
// \ --amount 3000000000000000000
// \ --chainId 1135
// \ --wallet gckms
// \ --token WETH
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
  const currentEthBalance = await connectedSigner.getBalance();
  console.log(
    `Current ${l1TokenInfo.symbol} balance for account ${signerAddr}: ${fromWei(
      currentBalance,
      l1TokenInfo.decimals
    )} ${l2Token}`
  );
  console.log(`Current ETH balance for account ${signerAddr}: ${fromWei(currentEthBalance)}`);

  // First offer user option to unwrap WETH into ETH
  if (l1TokenInfo.symbol === "ETH") {
    const weth = new Contract(l2Token, WETH9.abi, connectedSigner);
    if (await askYesNoQuestion(`\nUnwrap ${amount} of WETH @ ${weth.address}?`)) {
      const unwrap = await weth.withdraw(amount);
      console.log(`Submitted transaction: ${blockExplorerLink(unwrap.hash, chainId)}.`);
      const receipt = await unwrap.wait();
      console.log("Unwrap complete...", receipt);
    }
  }

  // Now, submit a withdrawal. This might fail if the ERC20 uses a non-standard OVM bridge to withdraw.
  const ovmStandardBridgeObj = CONTRACT_ADDRESSES[chainId].ovmStandardBridge;
  assert(CONTRACT_ADDRESSES[chainId].ovmStandardBridge, "ovmStandardBridge for chain not found in CONTRACT_ADDRESSES");
  const ovmStandardBridge = new Contract(ovmStandardBridgeObj.address, ovmStandardBridgeObj.abi, connectedSigner);
  const bridgeArgs =
    l1TokenInfo.symbol === "ETH"
      ? [
          signerAddr, // to
          200_000, // minGasLimit
          "0x", // extraData
          { value: amount }, // msg.value
        ]
      : [
          l2Token, // _localToken
          TOKEN_SYMBOLS_MAP[args.token]?.addresses[CHAIN_IDs.MAINNET], // Remote token to be received on L1 side. If the
          // remoteL1Token on the other chain does not recognize the local token as the correct
          // pair token, the ERC20 bridge will fail and the tokens will be returned to sender on
          // this chain.
          signerAddr, // _to
          amount, // _amount
          200_000, // minGasLimit
          "0x", // _data
        ];

  const functionNameToCall = l1TokenInfo.symbol === "ETH" ? "bridgeETHTo" : "bridgeERC20To";
  console.log(
    `Submitting ${functionNameToCall} on the OVM standard bridge @ ${ovmStandardBridge.address} with the following args: `,
    ...bridgeArgs
  );

  // Sanity check that the ovmStandardBridge contract is the one we expect by comparing its stored addresses
  // with the ones we have recorded.
  const spokePool = await getOvmSpokePoolContract(chainId, connectedSigner);
  const expectedL2Messenger = await spokePool.MESSENGER();
  const l2Messenger = await ovmStandardBridge.MESSENGER();
  assert(
    l2Messenger === expectedL2Messenger,
    `Unexpected L2 messenger address in ovmStandardBridge contract, expected: ${expectedL2Messenger}, got: ${l2Messenger}`
  );
  const l1StandardBridge = await ovmStandardBridge.l1TokenBridge();
  const expectedL1StandardBridge = CONTRACT_ADDRESSES[CHAIN_IDs.MAINNET][`ovmStandardBridge_${chainId}`].address;
  assert(
    l1StandardBridge === expectedL1StandardBridge,
    `Unexpected L1 standard bridge address in ovmStandardBridge contract, expected: ${expectedL1StandardBridge}, got: ${l1StandardBridge}`
  );
  const customTokenBridge = await spokePool.tokenBridges(l2Token);
  assert(customTokenBridge === ZERO_ADDRESS, `Custom token bridge set for token ${l2Token} (${customTokenBridge})`);
  if (!(await askYesNoQuestion("\nDo you want to proceed?"))) {
    return;
  }
  const withdrawal = await ovmStandardBridge[functionNameToCall](...bridgeArgs);
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
