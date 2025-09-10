// This script can be used to send USDT between Hypercore and HyperEVM and also submit a transaction with
// calldata on HyperEVM.

import { assert, BigNumber, Contract, ERC20, ethers, fromWei, getProvider } from "../src/utils";
import { retrieveSignerFromCLIArgs } from "../src/utils/CLIUtils";

export async function run(): Promise<void> {
  const hyperEvmChainId = 99;
  const provider = await getProvider(hyperEvmChainId);
  const baseSigner = await retrieveSignerFromCLIArgs();
  const signerAddr = await baseSigner.getAddress();
  const connectedSigner = baseSigner.connect(provider);
  console.log(`Connected to HyperEVM with signer address: ${signerAddr}`);

  // 1. First make sure account has enough HYPE on EVM to pay for gas.
  const nativeBalance = await connectedSigner.getBalance();
  assert(nativeBalance.gt(0), "Native balance should be greater than 0");
  console.log(`Native HYPE balance: ${fromWei(nativeBalance)} HYPE`);

  // 2. Check USDT balance on EVM and confirm with user how much they want to send.
  const USDT_EVM_ADDRESS = "0xB8CE59FC3717ada4C02eaDF9682A9e934F625ebb";
  const usdtEvm = new Contract(USDT_EVM_ADDRESS, ERC20.abi, connectedSigner);
  const [usdtEvmBalance, usdtDecimals] = await Promise.all([
    usdtEvm.balanceOf(await connectedSigner.getAddress()),
    usdtEvm.decimals(),
  ]);
  console.log(`USDT balance on EVM: ${fromWei(usdtEvmBalance, usdtDecimals)} USDT`);

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
  const totalUsdtBalance = decodedQueryResult[0].toString();
  const holdUsdtBalance = decodedQueryResult[1].toString();
  const entryNtlUsdtBalance = decodedQueryResult[2].toString();
  console.log(
    `Total USDT balance on Hypercore: ${fromWei(totalUsdtBalance, spotUsdtDecimals)} total, ${fromWei(
      holdUsdtBalance,
      spotUsdtDecimals
    )} hold, ${fromWei(entryNtlUsdtBalance, spotUsdtDecimals)} entryNtl`
  );

  // 4a. Allow user to send USDT from EVM to Spot using CoreWriter on EVM.
  const CORE_WRITER_EVM_ADDRESS = "0x3333333333333333333333333333333333333333";

  // 4b. Allow user to send USDT from Spot to EVM using USDT system address on EVM.
  // Address of system USDT contract on EVM that can be called to transfer core assets to EVM by calling
  // USDT.transfer(recipient=systemAddress, amount=amount) which credits the sender's EVM account. The fact that
  // we cannot choose which recipient to receive funds at is why we might need an intermediate step to custody user
  // funds before calling USDT.transfer(recipient=systemAddress, amount=amount).

  const USDT_EVM_SYSTEM_ADDRESS = "0x200000000000000000000000000000000000010C"; // USDT has token index 268 == 0x010C
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
