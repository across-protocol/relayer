// Submits a bridge from OpStack L2 to L1.
// For now, this script only supports ETH withdrawals.
import {
  ethers,
  EvmAddress,
  retrieveSignerFromCLIArgs,
  getProvider,
  ERC20,
  WETH9,
  resolveAcrossToken,
  assert,
  getL1TokenAddress,
  Contract,
  fromWei,
  blockExplorerLink,
  CHAIN_IDs,
  ZERO_ADDRESS,
  getTokenInfo,
} from "../src/utils";
import { getContractEntry } from "../src/common";
import { askYesNoQuestion, getOvmSpokePoolContract } from "./utils";

import minimist from "minimist";

const cliArgs = ["amount", "chainId", "token"];
const args = minimist(process.argv.slice(2), {
  string: cliArgs,
});

// Example run:
// tsx ./scripts/withdrawFromOpStack.ts
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
  const l2Token = EvmAddress.from(resolveAcrossToken(String(args.token), chainId, true));
  const l1TokenAddress = getL1TokenAddress(l2Token, chainId);
  const { symbol, decimals } = getTokenInfo(l2Token, chainId);
  const amount = args.amount;
  const amountFromWei = ethers.utils.formatUnits(amount, decimals);
  console.log(`Amount to bridge from chain ${chainId}: ${amountFromWei} ${l2Token}`);

  const erc20 = new Contract(l2Token.toNative(), ERC20.abi, connectedSigner);
  const currentBalance = await erc20.balanceOf(signerAddr);
  const currentEthBalance = await connectedSigner.getBalance();
  console.log(`Current ${symbol} balance for account ${signerAddr}: ${fromWei(currentBalance, decimals)} ${l2Token}`);
  console.log(`Current ETH balance for account ${signerAddr}: ${fromWei(currentEthBalance)}`);

  // First offer user option to unwrap WETH into ETH
  if (symbol === "ETH") {
    const weth = new Contract(l2Token.toNative(), WETH9.abi, connectedSigner);
    if (await askYesNoQuestion(`\nUnwrap ${amount} of WETH @ ${weth.address}?`)) {
      const unwrap = await weth.withdraw(amount);
      console.log(`Submitted transaction: ${blockExplorerLink(unwrap.hash, chainId)}.`);
      const receipt = await unwrap.wait();
      console.log("Unwrap complete...", receipt);
    }
  }

  // Now, submit a withdrawal. Tokens with a custom bridge registered on the SpokePool (e.g. DAI on
  // Optimism via Maker's L2DAITokenBridge) withdraw via the legacy IL2ERC20Bridge interface;
  // everything else goes via the OVM standard bridge.
  const spokePool = await getOvmSpokePoolContract(chainId, connectedSigner);
  const expectedL2Messenger = await spokePool.MESSENGER();
  const customTokenBridge = symbol === "ETH" ? ZERO_ADDRESS : await spokePool.tokenBridges(l2Token.toNative());

  let bridge: Contract;
  let functionNameToCall: string;
  let bridgeArgs: unknown[];
  if (customTokenBridge !== ZERO_ADDRESS) {
    const customBridgeAbi = [
      "function withdrawTo(address _l2Token, address _to, uint256 _amount, uint32 _l1Gas, bytes _data)",
      "function messenger() view returns (address)",
      "function l1Token() view returns (address)",
      "function l2Token() view returns (address)",
    ];
    bridge = new Contract(customTokenBridge, customBridgeAbi, connectedSigner);
    functionNameToCall = "withdrawTo";
    bridgeArgs = [
      l2Token.toNative(), // _l2Token
      signerAddr, // _to
      amount, // _amount
      200_000, // _l1Gas
      "0x", // _data
    ];

    // Sanity check the bridge wiring. Custom bridges without these getters (i.e. that don't
    // implement the legacy interface) fail here, before anything is submitted.
    const [l2Messenger, bridgeL1Token, bridgeL2Token] = await Promise.all([
      bridge.messenger(),
      bridge.l1Token(),
      bridge.l2Token(),
    ]);
    assert(
      l2Messenger === expectedL2Messenger,
      `Unexpected L2 messenger address in custom token bridge, expected: ${expectedL2Messenger}, got: ${l2Messenger}`
    );
    assert(
      bridgeL1Token === l1TokenAddress.toNative(),
      `Unexpected L1 token in custom token bridge, expected: ${l1TokenAddress}, got: ${bridgeL1Token}`
    );
    assert(
      bridgeL2Token === l2Token.toNative(),
      `Unexpected L2 token in custom token bridge, expected: ${l2Token}, got: ${bridgeL2Token}`
    );
  } else {
    const ovmStandardBridgeObj = getContractEntry(chainId, "ovmStandardBridge");
    bridge = new Contract(ovmStandardBridgeObj.address, ovmStandardBridgeObj.abi, connectedSigner);
    functionNameToCall = symbol === "ETH" ? "bridgeETHTo" : "bridgeERC20To";
    bridgeArgs =
      symbol === "ETH"
        ? [
            signerAddr, // to
            200_000, // minGasLimit
            "0x", // extraData
            { value: amount }, // msg.value
          ]
        : [
            l2Token.toNative(), // _localToken
            l1TokenAddress.toNative(), // Remote token to be received on L1 side. If the
            // remoteL1Token on the other chain does not recognize the local token as the correct
            // pair token, the ERC20 bridge will fail and the tokens will be returned to sender on
            // this chain.
            signerAddr, // _to
            amount, // _amount
            200_000, // minGasLimit
            "0x", // _data
          ];

    // Sanity check that the ovmStandardBridge contract is the one we expect by comparing its stored addresses
    // with the ones we have recorded.
    const l2Messenger = await bridge.MESSENGER();
    assert(
      l2Messenger === expectedL2Messenger,
      `Unexpected L2 messenger address in ovmStandardBridge contract, expected: ${expectedL2Messenger}, got: ${l2Messenger}`
    );
    const l1StandardBridge = await bridge.l1TokenBridge();
    const expectedL1StandardBridge = getContractEntry(CHAIN_IDs.MAINNET, `ovmStandardBridge_${chainId}`).address;
    assert(
      l1StandardBridge === expectedL1StandardBridge,
      `Unexpected L1 standard bridge address in ovmStandardBridge contract, expected: ${expectedL1StandardBridge}, got: ${l1StandardBridge}`
    );
  }

  const bridgeType = customTokenBridge !== ZERO_ADDRESS ? "custom token" : "OVM standard";
  console.log(
    `Submitting ${functionNameToCall} on the ${bridgeType} bridge @ ${bridge.address} with the following args: `,
    ...bridgeArgs
  );

  if (!(await askYesNoQuestion("\nDo you want to proceed?"))) {
    return;
  }
  const withdrawal = await bridge[functionNameToCall](...bridgeArgs);
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
