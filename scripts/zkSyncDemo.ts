import { AugmentedTransaction, TransactionClient } from "../src/clients";
import { ethers, getSigner, getProvider, ERC20, ZERO_ADDRESS, toBN, Logger, Contract } from "../src/utils";
import { askYesNoQuestion } from "./utils";
import minimist from "minimist";
import * as zksync from "zksync-web3";
const args = minimist(process.argv.slice(2), {
  string: ["token", "to", "amount", "chainId", "zkSyncChainId"],
});

export const mailboxInterface = [
  { stateMutability: "payable", type: "fallback" },
  {
    inputs: [
      { internalType: "address", name: "_contractL2", type: "address" },
      { internalType: "uint256", name: "_l2Value", type: "uint256" },
      { internalType: "bytes", name: "_calldata", type: "bytes" },
      { internalType: "uint256", name: "_l2GasLimit", type: "uint256" },
      { internalType: "uint256", name: "_l2GasPerPubdataByteLimit", type: "uint256" },
      { internalType: "bytes[]", name: "_factoryDeps", type: "bytes[]" },
      { internalType: "address", name: "_refundRecipient", type: "address" },
    ],
    name: "requestL2Transaction",
    outputs: [{ internalType: "bytes32", name: "canonicalTxHash", type: "bytes32" }],
    stateMutability: "payable",
    type: "function",
  },
  {
    inputs: [
      { internalType: "uint256", name: "_gasPrice", type: "uint256" },
      { internalType: "uint256", name: "_l2GasLimit", type: "uint256" },
      { internalType: "uint256", name: "_l2GasPerPubdataByteLimit", type: "uint256" },
    ],
    name: "l2TransactionBaseCost",
    outputs: [{ internalType: "uint256", name: "", type: "uint256" }],
    stateMutability: "pure",
    type: "function",
  },
];

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
  if (!Object.keys(args).includes("zkSyncChainId")) {
    throw new Error("Define `zkSyncChainId` as the zkSync chain you want to connect on");
  }

  const baseSigner = await getSigner();
  const connectedSigner = baseSigner.connect(await getProvider(Number(args.chainId)));
  console.log("Connected to account", connectedSigner.address);
  const recipient = args.to;
  const token = args.token;
  if (!ethers.utils.isAddress(recipient)) {
    throw new Error("invalid addresses");
  }

  const txnClient = new TransactionClient(Logger);

  const zkSyncProvider = new zksync.Provider("https://mainnet.era.zksync.io");
  const zkSyncWeb3Wallet = new zksync.Wallet(baseSigner.privateKey, zkSyncProvider, connectedSigner.provider);

  // Deposit ETH to ZkSync
  if (token === ZERO_ADDRESS) {
    const mailboxContract = new Contract(
      "0x32400084C286CF3E17e7B677ea9583e60a000324",
      mailboxInterface,
      connectedSigner
    );
    const amountFromWei = ethers.utils.formatUnits(args.amount, 18);
    console.log(`Send ETH with amount ${amountFromWei} tokens to ${recipient} on chain ${args.zkSyncChainId}}`);
    if (!(await askYesNoQuestion("\nConfirm that you want to execute this transaction?"))) {
      return;
    }
    console.log("sending...");
    const method = "requestL2Transaction";
    const l2PubdataByteLimit = zksync.utils.REQUIRED_L1_TO_L2_GAS_PER_PUBDATA_LIMIT;
    const l2GasLimit = await zksync.utils.estimateDefaultBridgeDepositL2Gas(
      connectedSigner.provider,
      zkSyncProvider,
      zksync.utils.ETH_ADDRESS,
      toBN(args.amount),
      recipient,
      baseSigner.address,
      l2PubdataByteLimit
    );
    const params = [recipient, args.amount, "0x", l2GasLimit.toString(), l2PubdataByteLimit, [], recipient];
    console.log(
      `Params for 'requestL2Transaction': [_contractL2: ${params[0]}, _l2Value: ${params[1]}, _calldata: ${params[2]}, _l2GasLimit: ${params[3]}, _l2GasPerPubdataByteLimit: ${params[4]}, _factoryDeps: ${params[5]}, _refundRecipient: ${params[6]}]`
    );

    const estimatedL2GasPrice = await zkSyncProvider.getGasPrice();
    console.log("Estimated L2 gas price", estimatedL2GasPrice.toString());
    const l2TransactionBaseCost = estimatedL2GasPrice.mul(l2GasLimit);
    console.log("L2 transaction base cost", l2TransactionBaseCost.toString());
    const _l2TransactionBaseCost = await mailboxContract.l2TransactionBaseCost(
      estimatedL2GasPrice,
      l2GasLimit,
      l2PubdataByteLimit
    );
    console.log(`Contract estimated L2 transaction base cost: ${_l2TransactionBaseCost.toString()}`);
    const _txnRequest: AugmentedTransaction = {
      contract: mailboxContract,
      chainId: args.chainId,
      method,
      args: params,
      gasLimitMultiplier: 1,
      value: _l2TransactionBaseCost.add(args.amount),
      message: "Deposit ETH to ZkSync",
      mrkdwn: "Deposit ETH to ZkSync",
    };
    const simulationResult = (await txnClient.simulate([_txnRequest]))[0];
    if (simulationResult.succeed) {
      await txnClient.submit(args.chainId, [simulationResult.transaction]);
    } else {
      console.log("Simulation failed", simulationResult);
    }
  }
  // TODO: Use TxnClient
  // Send ERC20
  else {
    // const l1ERC20Bridge = new Contract("0x57891966931Eb4Bb6FB81430E6cE0A03AAbDe063", mailboxInterface, connectedSigner);
    const erc20 = new ethers.Contract(token, ERC20.abi, connectedSigner);
    const decimals = Number(await erc20.decimals());
    const symbol = await erc20.symbol();
    const amountFromWei = ethers.utils.formatUnits(args.amount, decimals);
    // Check the user is ok with the info provided. else abort.
    console.log(`Send ${symbol} with amount ${amountFromWei} tokens to ${recipient} on chain ${args.zkSyncChainId}`);
    if (!(await askYesNoQuestion("\nConfirm that you want to execute this transaction?"))) {
      return;
    }
    console.log("sending...");
    // const approval = await erc20.approve(l1ERC20Bridge.address, toBN(args.amount).mul(100));
    // console.log("Approval tx hash:", approval.hash);
    const tx = await zkSyncWeb3Wallet.deposit({
      to: recipient,
      token,
      amount: toBN(args.amount),
    });
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
