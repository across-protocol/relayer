// This script can be used to send USDT between Hypercore and HyperEVM and demonstrates how a deposit of USDT
// from any chain can be filled on HyperEVM and fund the end user's spot balance on Hypercore using the MulticallHandler.

import minimist from "minimist";
import { assert, BigNumber, Contract, ERC20, ethers, fromWei, getProvider, toBN, toBNWei } from "../src/utils";
import { retrieveSignerFromCLIArgs } from "../src/utils/CLIUtils";
import { askYesNoQuestion } from "./utils";

const args = minimist(process.argv.slice(2), {
  string: ["amount"],
  boolean: ["sendToEvm", "sendToCore", "delegateSendToCore"],
});

const HYPEREVM_CHAIN_ID = 999;
const USDT_EVM_ADDRESS = "0xB8CE59FC3717ada4C02eaDF9682A9e934F625ebb";
// USDT has token index 268 == 0x010C. The SystemAddress is used when transferring USDT between EVM and Core.
const USDT_TOKEN_INDEX = 268;
const USDT_EVM_SYSTEM_ADDRESS = "0x200000000000000000000000000000000000010C";
// Contract used to query Hypercore balances from EVM
const CORE_BALANCE_SYSTEM_PRECOMPILE = "0x0000000000000000000000000000000000000801";
// CoreWriter contract on EVM that can be used to interact with Hypercore.
const CORE_WRITER_EVM_ADDRESS = "0x3333333333333333333333333333333333333333";
// CoreWriter exposes a single function that charges 20k gas to send an instruction on Hypercore.
const CORE_WRITER_ABI = ["function sendRawAction(bytes)"];
// To transfer Core balance, a 'spotSend' action must be specified in the payload to sendRawAction:
const SPOT_SEND_PREFIX_BYTES = ethers.utils.hexlify([
  1, // byte 0: version, must be 1
  // bytes 1-3: unique action index as described here:
  // https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/hyperevm/interacting-with-hypercore#corewriter-contract
  0,
  0,
  6, // action index of spotSend is 6, so bytes 1-3 are 006
]);
// On Hypercore, USDT and most tokens have 8 decimals.
const CORE_DEFAULT_DECIMALS = 8;

// Contracts that I have deployed for the purposes of this script:
// Non production dummy MulticallHandler that was flattened for easier verification.
const MULTICALL_HANDLER_ADDRESS = "0xd2ecb3afe598b746f8123cae365a598da831a449";
// Non production dummy SpokePool deployed to trigger the multicall handler and for the user to approve so that the
// user doesn't need to approve the multicall handler, which would be dangerous for the user.
const DUMMY_SPOKE_POOL_ADDRESS = "0x6999526e507cc3b03b180bbe05e1ff938259a874";
// Non production dummy SpokePool exposes a single function that pulls tokens from the caller and sends to the
// multicaller handler (third argument) and passes a message to the multicall handler to execute.
const DUMMY_SPOKE_POOL_ABI = ["function mockFill(address,uint256,address,bytes)"];

export async function run(): Promise<void> {
  const provider = await getProvider(HYPEREVM_CHAIN_ID);
  const baseSigner = await retrieveSignerFromCLIArgs();
  const signerAddr = await baseSigner.getAddress();
  const connectedSigner = baseSigner.connect(provider);
  console.group(`***** Connected to HyperEVM with signer address: ${signerAddr} *****`);

  // 1. First make sure account has enough HYPE on EVM to pay for gas.
  const nativeBalance = await connectedSigner.getBalance();
  assert(nativeBalance.gt(0), "Native balance should be greater than 0");
  console.log(`- EVM HYPE balance: ${fromWei(nativeBalance)} HYPE`);

  // 2. Check USDT balance on EVM and confirm with user how much they want to send.
  const usdtEvm = new Contract(USDT_EVM_ADDRESS, ERC20.abi, connectedSigner);
  const [usdtEvmBalance, usdtDecimals] = await Promise.all([
    usdtEvm.balanceOf(await connectedSigner.getAddress()),
    usdtEvm.decimals(),
  ]);
  console.log(`- EVM USDT balance: ${fromWei(usdtEvmBalance, usdtDecimals)} USDT`);

  // 3. Check USDT balance on Hypercore.
  const getCoreBalance = async (address: string) => {
    const balanceCoreCalldata = ethers.utils.defaultAbiCoder.encode(["address", "uint64"], [address, USDT_TOKEN_INDEX]);
    const queryResult = await provider.call({
      to: CORE_BALANCE_SYSTEM_PRECOMPILE,
      data: balanceCoreCalldata,
    });
    // @dev These labels of the spot balances are taken from the L1Read.sol example in the documentation here
    // https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/hyperevm/interacting-with-hypercore
    type SpotBalance = [BigNumber /* total */, BigNumber /* hold */, BigNumber /* entryNtl */];
    const decodedQueryResult: SpotBalance = ethers.utils.defaultAbiCoder.decode(
      ["uint64", "uint64", "uint64"], // total, hold, entryNtl
      queryResult
    ) as unknown as SpotBalance;
    return toBN(decodedQueryResult[0].toString());
  };
  const totalUsdtBalance = await getCoreBalance(signerAddr);
  const multicallHandlerUsdtCoreBalance = await getCoreBalance(MULTICALL_HANDLER_ADDRESS);
  console.log(`- [Signer] Hypercore USDT balance: ${fromWei(totalUsdtBalance, CORE_DEFAULT_DECIMALS)} USDT`);
  console.log(
    `- [MulticallHandler] Hypercore USDT balance: ${fromWei(
      multicallHandlerUsdtCoreBalance,
      CORE_DEFAULT_DECIMALS
    )} USDT`
  );
  console.groupEnd();

  // If user did not specify an action, exit after printing balances.
  if (!(args.sendToCore || args.sendToEvm || args.delegateSendToCore)) {
    return;
  }

  // To send USDT from Spot account, we need the following information:
  const coreWriter = new Contract(CORE_WRITER_EVM_ADDRESS, CORE_WRITER_ABI, connectedSigner);
  // Remaining bytes are action specific params, also described in docs.
  const amountToSend_CORE_PRECISION = toBNWei(args.amount, CORE_DEFAULT_DECIMALS);
  // Use the following bytes to withdraw from Core to EVM.
  const spotSendArgBytes_withdrawFromCore = ethers.utils.defaultAbiCoder.encode(
    ["address", "uint64", "uint64"],
    [USDT_EVM_SYSTEM_ADDRESS, USDT_TOKEN_INDEX, amountToSend_CORE_PRECISION]
  );
  // Use the following bytes to transfer on Core between accounts, for example between the MulticallHandler
  // and the user.
  const spotSendArgBytes_transferOnCore = ethers.utils.defaultAbiCoder.encode(
    ["address", "uint64", "uint64"],
    [signerAddr, USDT_TOKEN_INDEX, amountToSend_CORE_PRECISION]
  );
  const amountToSend_EVM_PRECISION = toBNWei(args.amount, usdtDecimals);

  // 4a. Allow user to send USDT from EVM to Spot by transferring to the special USDT system address on EVM.
  if (args.sendToCore) {
    console.group(
      `\n***** Sending ${fromWei(
        amountToSend_EVM_PRECISION,
        usdtDecimals
      )} USDT from EVM to Core using CoreWriter on EVM *****`
    );
    assert(usdtEvmBalance.gte(amountToSend_EVM_PRECISION), "USDT balance on EVM is less than amount to send");
    assert(await askYesNoQuestion("\nConfirm that you want to execute this transaction?\n"), "User did not confirm");
    const txn = await usdtEvm.transfer(USDT_EVM_SYSTEM_ADDRESS, amountToSend_EVM_PRECISION);
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
    console.group(
      `\n***** Sending ${fromWei(
        amountToSend_CORE_PRECISION,
        CORE_DEFAULT_DECIMALS
      )} USDT from Core to EVM using USDT system address on EVM *****`
    );
    assert(totalUsdtBalance.gte(amountToSend_CORE_PRECISION), "USDT balance on Core is less than amount to send");
    assert(await askYesNoQuestion("\nConfirm that you want to execute this transaction?\n"), "User did not confirm");
    // @dev costs 20k gas on HyperEVM
    const spotSendBytes = ethers.utils.hexlify(
      ethers.utils.concat([SPOT_SEND_PREFIX_BYTES, spotSendArgBytes_withdrawFromCore])
    );
    const txn = await coreWriter.sendRawAction(spotSendBytes);
    const receipt = await txn.wait();
    console.log(`- Transferred USDT from Core to EVM. Transaction hash: ${receipt.transactionHash}`);
    console.groupEnd();
  }

  // 4c. Allow sending USDT from EVM to Spot via the MulticallHandler on EVM.
  // @dev I've noticed from experience that this fails if the sender of the spot balance to the user, i.e. the
  // the MulticallHander, is a brand new contract that has never held a USDT balance before, and I've gotten it to
  // work by transferring USDT to it. I'm not sure exactly why this worked in the past but FYI.
  if (args.delegateSendToCore) {
    console.group(
      `\n***** Sending ${fromWei(
        amountToSend_EVM_PRECISION,
        usdtDecimals
      )} USDT from EVM to Core using MulticallHandler on EVM *****`
    );
    assert(await askYesNoQuestion("\nConfirm that you want to execute this transaction?\n"), "User did not confirm");
    // We want to simulate filling an Across deposit on HyperEVM in order to fund the end user's spot balance, so
    // we need to construct a MulticallHandler Call list that includes the following calls:
    // - 1) Transfer USDT from EVM to Core balance
    // - 2) Transfer USDT from Core balance to MulticallHandler via the CoreWriter on EVM.
    interface MulticallHandlerCall {
      target: string;
      callData: string;
      value: string;
    }
    const call1: MulticallHandlerCall = {
      target: usdtEvm.address,
      callData: usdtEvm.interface.encodeFunctionData("transfer", [USDT_EVM_SYSTEM_ADDRESS, amountToSend_EVM_PRECISION]),
      value: "0",
    };
    const spotSendBytes = ethers.utils.hexlify(
      ethers.utils.concat([SPOT_SEND_PREFIX_BYTES, spotSendArgBytes_transferOnCore])
    );
    const call2: MulticallHandlerCall = {
      target: coreWriter.address,
      callData: coreWriter.interface.encodeFunctionData("sendRawAction", [spotSendBytes]),
      value: "0",
    };
    const message = buildMulticallHandlerMessage({
      actions: [call1, call2],
      fallbackRecipient: signerAddr,
    });

    // Now, we need to execute the following transactions in sequence:
    // - 1) Approve the DummySpokePool
    // - 2) Call mockFill() on the DummySpoke which transfers the USDT from User to the MulticallHandler.
    // multicall handler deployed and used for demonstration purposes.
    const dummySpokePool = new Contract(DUMMY_SPOKE_POOL_ADDRESS, DUMMY_SPOKE_POOL_ABI, connectedSigner);
    const approvalTxn = await usdtEvm.approve(DUMMY_SPOKE_POOL_ADDRESS, amountToSend_EVM_PRECISION);
    const approvalTxnReceipt = await approvalTxn.wait();
    console.log(
      `- (Step 2) Approved USDT from EVM to DummySpokePool. Transaction hash: ${approvalTxnReceipt.transactionHash}`
    );
    const mockFillTxn = await dummySpokePool.mockFill(
      usdtEvm.address,
      amountToSend_EVM_PRECISION,
      MULTICALL_HANDLER_ADDRESS,
      message
    );
    const mockFillTxnReceipt = await mockFillTxn.wait();
    console.log(
      `- (Step 3) Called mockFill() on the DummySpokePool. Transaction hash: ${mockFillTxnReceipt.transactionHash}`
    );
    console.groupEnd();
  }

  // TODO:
  // 5a. Allow sending HYPE from EVM to Spot.
  // 5b. Allow sending HYPE from Spot to EVM.
  // 6a. Allow sending USDT from spot to EVM and then triggering an action on EVM once the tokens are received.
}

export function buildMulticallHandlerMessage(params: {
  actions: Array<{
    target: string;
    callData: string;
    value: string;
  }>;
  fallbackRecipient: string;
}): string {
  const abiCoder = ethers.utils.defaultAbiCoder;

  return abiCoder.encode(
    [
      "tuple(" +
        "tuple(" +
        "address target," +
        "bytes callData," +
        "uint256 value" +
        ")[]," +
        "address fallbackRecipient" +
        ")",
    ],
    [
      [
        params.actions.map(({ target, callData, value }) => ({
          target,
          callData,
          value: BigNumber.from(value),
        })),
        params.fallbackRecipient,
      ],
    ]
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
