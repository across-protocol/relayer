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
    CHAIN_IDs,
  } from "../src/utils";
  import { CONTRACT_ADDRESSES } from "../src/common";
  import { askYesNoQuestion, getArbSpokePoolContract } from "./utils";
  
  import minimist from "minimist";
  
  const cliArgs = ["amount", "chainId"];
  const args = minimist(process.argv.slice(2), {
    string: cliArgs,
  });
  
  // Example run:
  // ts-node ./scripts/withdrawFromArbitrumOrbit.ts
  // \ --amount 3000000000000000000
  // \ --chainId 41455
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
    const l2Token =  TOKEN_SYMBOLS_MAP.WETH?.addresses[chainId];
    assert(l2Token, `WETH not found on chain ${chainId} in TOKEN_SYMBOLS_MAP`);
    // const l1TokenInfo = getL1TokenInfo(l2Token, chainId);
    // console.log("Fetched L1 token info:", l1TokenInfo);
    // assert(l1TokenInfo.symbol === "ETH", "Only WETH withdrawals are supported for now.");
    const amount = args.amount;
    const amountFromWei = ethers.utils.formatUnits(amount, 18/*l1TokenInfo.decimals*/);
    console.log(`Amount to bridge from chain ${chainId}: ${amountFromWei} ${l2Token}`);
  
    const erc20 = new Contract(l2Token, ERC20.abi, connectedSigner);
    const currentBalance = await erc20.balanceOf(signerAddr);
    const currentEthBalance = await connectedSigner.getBalance();
    console.log(
      `Current WETH balance for account ${signerAddr}: ${fromWei(currentBalance, 18/*l1TokenInfo.decimals*/)} ${l2Token}`
    );
    console.log(`Current ETH balance for account ${signerAddr}: ${fromWei(currentEthBalance, 18/*l1TokenInfo.decimals*/)}`);
  
    // Now, submit a withdrawal:
    // - Example WETH: 0xB3f0eE446723f4258862D949B4c9688e7e7d35d3
    // - Example ERC20GatewayRouter: https://evm-explorer.alephzero.org/address/0xD296d45171B97720D3aBdb68B0232be01F1A9216?tab=read_proxy
    // - Example Txn: https://evm-explorer.alephzero.org/tx/0xb493174af0822c1a5a5983c2cbd4fe74055ee70409c777b9c665f417f89bde92
    const arbErc20GatewayRouterObj = CONTRACT_ADDRESSES[chainId].erc20GatewayRouter;
    assert(arbErc20GatewayRouterObj, "erc20GatewayRouter for chain not found in CONTRACT_ADDRESSES");
    const erc20GatewayRouter = new Contract(arbErc20GatewayRouterObj.address, arbErc20GatewayRouterObj.abi, connectedSigner);
    const outboundTransferArgs = [
        TOKEN_SYMBOLS_MAP.WETH?.addresses[CHAIN_IDs.MAINNET], // l1Token
        signerAddr, // to
        amount, // amount
        "0x", // data
    ];
  
    console.log(
      `Submitting outboundTransfer on the Arbitrum ERC20 gateway router @ ${erc20GatewayRouter.address} with the following args: `,
      ...outboundTransferArgs
    );
  
    // Sanity check that the ovmStandardBridge contract is the one we expect by comparing its stored addresses
    // with the ones we have recorded.
    const spokePool = await getArbSpokePoolContract(chainId, connectedSigner);
    const expectedErc20GatewayRouter = await spokePool.l2GatewayRouter();
    assert(
        expectedErc20GatewayRouter === arbErc20GatewayRouterObj.address,
      `Unexpected L2 erc20 gateway router address in ArbitrumSpokePool contract, expected: ${expectedErc20GatewayRouter}, got: ${arbErc20GatewayRouterObj.address}`
    );
    if (!(await askYesNoQuestion("\nDo you want to proceed?"))) {
      return;
    }
    const withdrawal = await erc20GatewayRouter.outboundTransfer(...outboundTransferArgs);
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
  