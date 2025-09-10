// This script can be used to send USDT between Hypercore and HyperEVM and also submit a transaction with
// calldata on HyperEVM.

import minimist from "minimist";
import { assert, BigNumber, Contract, ERC20, ethers, fromWei, getProvider, toBN, toBNWei, toWei } from "../src/utils";
import { retrieveSignerFromCLIArgs } from "../src/utils/CLIUtils";
import { askYesNoQuestion } from "./utils";

const args = minimist(process.argv.slice(2), {
  string: ["amount"],
  boolean: ["sendToEvm", "sendToCore"],
});

export async function run(): Promise<void> {
  const hyperEvmChainId = 999;
  const provider = await getProvider(hyperEvmChainId);
  const baseSigner = await retrieveSignerFromCLIArgs();
  const signerAddr = await baseSigner.getAddress();
  const connectedSigner = baseSigner.connect(provider);
  const providerChainId = await connectedSigner.getChainId();
  assert(providerChainId === hyperEvmChainId, "Provider chain ID does not match HyperEVM chain ID");
  console.group(`***** Connected to HyperEVM with signer address: ${signerAddr} *****`);

  // 1. First make sure account has enough HYPE on EVM to pay for gas.
  const nativeBalance = await connectedSigner.getBalance();
  assert(nativeBalance.gt(0), "Native balance should be greater than 0");
  console.log(`- EVM HYPE balance: ${fromWei(nativeBalance)} HYPE`);

  // 2. Check USDT balance on EVM and confirm with user how much they want to send.
  const USDT_EVM_ADDRESS = "0xB8CE59FC3717ada4C02eaDF9682A9e934F625ebb";
  const usdtEvm = new Contract(USDT_EVM_ADDRESS, ERC20.abi, connectedSigner);
  const [usdtEvmBalance, usdtDecimals] = await Promise.all([
    usdtEvm.balanceOf(await connectedSigner.getAddress()),
    usdtEvm.decimals(),
  ]);
  console.log(`- EVM USDT balance: ${fromWei(usdtEvmBalance, usdtDecimals)} USDT`);

  // 3. Check USDT balance on Hypercore.
  const USDT_TOKEN_INDEX = 268;
  const coreBalanceSystemPrecompile = "0x0000000000000000000000000000000000000801";
  const abiEncodedCallData = ethers.utils.defaultAbiCoder.encode(["address", "uint64"], [signerAddr, USDT_TOKEN_INDEX]);
  const queryResult = await provider.call({
    to: coreBalanceSystemPrecompile,
    data: abiEncodedCallData,
  });
  type SpotBalance = [BigNumber /* total */, BigNumber /* hold */, BigNumber /* entryNtl */];
  const decodedQueryResult: SpotBalance = ethers.utils.defaultAbiCoder.decode(
    ["uint64", "uint64", "uint64"],
    queryResult
  ) as unknown as SpotBalance;
  const spotUsdtDecimals = 8;
  const totalUsdtBalance = toBN(decodedQueryResult[0].toString());
  const holdUsdtBalance = toBN(decodedQueryResult[1].toString());
  const entryNtlUsdtBalance = toBN(decodedQueryResult[2].toString());
  // @dev These labels of the spot balances are taken from the L1Read.sol example in the documentation here
  // https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/hyperevm/interacting-with-hypercore
  console.log(
    `- Hypercore USDT balance: ${fromWei(totalUsdtBalance, spotUsdtDecimals)} total, ${fromWei(
      holdUsdtBalance,
      spotUsdtDecimals
    )} hold, ${fromWei(entryNtlUsdtBalance, spotUsdtDecimals)} entryNtl`
  );
  console.groupEnd();

  // 4a. Allow user to send USDT from EVM to Spot using CoreWriter on EVM.
  const USDT_EVM_SYSTEM_ADDRESS = "0x200000000000000000000000000000000000010C"; // USDT has token index 268 == 0x010C
  if (args.sendToCore) {
    const amountToSend = toBNWei(args.amount, usdtDecimals);
    console.group(
      `\n***** Sending ${fromWei(amountToSend, usdtDecimals)} USDT from EVM to Core using CoreWriter on EVM *****`
    );
    assert(usdtEvmBalance.gte(amountToSend), "USDT balance on EVM is less than amount to send");
    assert(await askYesNoQuestion("\nConfirm that you want to execute this transaction?\n"), "User did not confirm");
    const txn = await usdtEvm.transfer(USDT_EVM_SYSTEM_ADDRESS, amountToSend);
    const receipt = await txn.wait();
    console.log(`- Transferred USDT from EVM to Core. Transaction hash: ${receipt.transactionHash}`);
    console.groupEnd();
  }

  // 4b. Allow user to send USDT from Spot to EVM using USDT system address on EVM.
  // Address of system USDT contract on EVM that can be called to transfer core assets to EVM by calling
  // USDT.transfer(recipient=systemAddress, amount=amount) which credits the sender's EVM account. The fact that
  // we cannot choose which recipient to receive funds at is why we might need an intermediate step to custody user
  // funds before calling USDT.transfer(recipient=systemAddress, amount=amount).

  if (args.sendToEvm) {
    const CORE_WRITER_EVM_ADDRESS = "0x3333333333333333333333333333333333333333";
    const CORE_WRITER_ABI = ["function sendRawAction(bytes)"];
    const coreWriter = new Contract(CORE_WRITER_EVM_ADDRESS, CORE_WRITER_ABI, connectedSigner);
    const amountToSend = toBNWei(args.amount, spotUsdtDecimals);
    console.group(
      `\n***** Sending ${fromWei(
        amountToSend,
        spotUsdtDecimals
      )} USDT from Core to EVM using USDT system address on EVM *****`
    );
    assert(totalUsdtBalance.gte(amountToSend), "USDT balance on Core is less than amount to send");
    assert(await askYesNoQuestion("\nConfirm that you want to execute this transaction?\n"), "User did not confirm");
    const spotSendPrefixBytes = ethers.utils.hexlify([
      1, // byte 0: version, must be 1
      // bytes 1-3: unique action index as described here:
      // https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/hyperevm/interacting-with-hypercore#corewriter-contract
      0,
      0,
      6, // action index of spotSend is 6, so bytes 1-3 are 006
    ]);
    // Remaining bytes are action specific params, also described in docs.
    const spotSendArgBytes = ethers.utils.defaultAbiCoder.encode(
      ["address", "uint64", "uint64"],
      [USDT_EVM_SYSTEM_ADDRESS, USDT_TOKEN_INDEX, amountToSend]
    );
    const spotSendBytes = ethers.utils.hexlify(ethers.utils.concat([spotSendPrefixBytes, spotSendArgBytes]));
    // @dev costs 20k gas on HyperEVM
    const txn = await coreWriter.sendRawAction(spotSendBytes);
    const receipt = await txn.wait();
    console.log(`- Transferred USDT from Core to EVM. Transaction hash: ${receipt.transactionHash}`);
    console.groupEnd();
  }

  // TODO:
  // 5a. Allow sending HYPE from EVM to Spot.
  // 5b. Allow sending HYPE from Spot to EVM.
  // 6a. Allow sending USDT from spot to EVM and then triggering an action on EVM once the tokens are received.
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
