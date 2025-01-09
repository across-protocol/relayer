import { AugmentedTransaction, TransactionClient } from "../src/clients";
import {
  ethers,
  retrieveSignerFromCLIArgs,
  getProvider,
  ERC20,
  ZERO_ADDRESS,
  toBN,
  Logger,
  Contract,
  isDefined,
  TransactionSimulationResult,
} from "../src/utils";
import { askYesNoQuestion } from "./utils";
import minimist from "minimist";
import * as zksync from "zksync-ethers";
import { CONTRACT_ADDRESSES } from "../src/common";
import { gasPriceOracle } from "@across-protocol/sdk";
const args = minimist(process.argv.slice(2), {
  string: ["token", "to", "amount", "chainId", "zkSyncChainId"],
});

export async function run(): Promise<void> {
  console.log("Executing Token sender 💸");
  Object.entries({
    token: "Define `token` as the address of the token to send",
    amount: "Define `amount` as how much you want to send",
    to: "Define `to` as where you want to send funds to",
    chainId: "Define `chainId` as the chain you want to connect on",
    zkSyncChainId: "Define `zkSyncChainId` as the zkSync chain you want to connect on",
  }).forEach(([key, errMsg]) => {
    if (!isDefined(args[key])) {
      throw new Error(errMsg);
    }
  });

  const baseSigner = await retrieveSignerFromCLIArgs();
  const signerAddr = await baseSigner.getAddress();
  const l1ChainId = Number(args.chainId);
  const l1Provider = await getProvider(l1ChainId);
  const connectedSigner = baseSigner.connect(l1Provider);
  console.log(`Connected to account ${signerAddr}`);
  const recipient = args.to;
  const token = args.token;
  if (!ethers.utils.isAddress(recipient)) {
    throw new Error(`invalid "to" address: ${recipient}`);
  }
  if (!ethers.utils.isAddress(token)) {
    throw new Error(`invalid "token" address: ${token}`);
  }

  const txnClient = new TransactionClient(Logger);

  const zkSyncProvider = new zksync.Provider("https://mainnet.era.zksync.io");
  const zkSyncMailboxContractData = CONTRACT_ADDRESSES[l1ChainId]?.zkSyncMailbox;
  if (!zkSyncMailboxContractData) {
    throw new Error(`zkSyncMailboxContractData not found for chain ${l1ChainId}`);
  }
  const mailboxContract = new Contract(
    zkSyncMailboxContractData.address,
    zkSyncMailboxContractData.abi,
    connectedSigner
  );
  const l2PubdataByteLimit = zksync.utils.REQUIRED_L1_TO_L2_GAS_PER_PUBDATA_LIMIT;
  const l1GasPriceData = await gasPriceOracle.getGasPriceEstimate(l1Provider, { chainId: l1ChainId });
  const estimatedL1GasPrice = l1GasPriceData.maxPriorityFeePerGas.add(l1GasPriceData.maxFeePerGas);
  // The ZkSync Mailbox contract checks that the msg.value of the transaction is enough to cover the transaction base
  // cost. The transaction base cost can be queried from the Mailbox by passing in an L1 "executed" gas price,
  // which is the priority fee plus base fee. This is the same as calling tx.gasprice on-chain as the Mailbox
  // contract does here:
  // https://github.com/matter-labs/era-contracts/blob/3a4506522aaef81485d8abb96f5a6394bd2ba69e/ethereum/contracts/zksync/facets/Mailbox.sol#L287
  console.log("Actual L1 gas price (e.g. tx.gasprice)", estimatedL1GasPrice.toString());

  let simulationResult: TransactionSimulationResult;

  // TODO: Track outstanding transfers, which is needed in ZkSyncAdapter:
  // L1: DepositInitiated(l2DepositTxHash, from, to, l1Token,amount): https://etherscan.io/tx/0x9fc458abe311d5ba7fc9a887e595fa251b24604a286a794ce53f7cb634f29df2#eventlog
  // L2: TODO figure out how to decode: https://explorer.zksync.io/tx/0xb4df1f44abd7b14afe10af3b0b1eb70ab610ace1e1a6c0ec55742849b77ae9a2#overview
  // L2 contract should call finalizeDeposit(l1Sender, l2Receiver, l1Token, amount, bridgeData):
  // https://github.com/matter-labs/era-contracts/blob/main/zksync/contracts/bridge/L2ERC20Bridge.sol#L62
  // Deposit ETH to ZkSync
  if (token === ZERO_ADDRESS) {
    const amountFromWei = ethers.utils.formatUnits(args.amount, 18);
    console.log(`Send ETH with amount ${amountFromWei} tokens to ${recipient} on chain ${args.zkSyncChainId}`);
    if (!(await askYesNoQuestion("\nConfirm that you want to execute this transaction?"))) {
      return;
    }
    console.log("sending...");
    const method = "requestL2Transaction";
    const l2GasLimit = await zksync.utils.estimateDefaultBridgeDepositL2Gas(
      connectedSigner.provider,
      zkSyncProvider,
      token,
      toBN(args.amount),
      recipient,
      signerAddr,
      l2PubdataByteLimit
    );
    const params = [recipient, args.amount, "0x", l2GasLimit.toString(), l2PubdataByteLimit, [], recipient];
    const l2TransactionBaseCost = await mailboxContract.l2TransactionBaseCost(
      estimatedL1GasPrice,
      l2GasLimit,
      l2PubdataByteLimit
    );
    console.log(`Contract estimated L2 transaction base cost: ${l2TransactionBaseCost.toString()}`);
    const _txnRequest: AugmentedTransaction = {
      contract: mailboxContract,
      chainId: args.chainId,
      method,
      args: params,
      // Empirically I've seen that without this gas cost multiplier, transactions sometimes run out of gas.
      gasLimitMultiplier: 3,
      value: l2TransactionBaseCost.add(args.amount),
      message: "Deposit ETH to ZkSync",
      mrkdwn: "Deposit ETH to ZkSync",
    };
    simulationResult = (await txnClient.simulate([_txnRequest]))[0];
  }
  // Send ERC20
  else {
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

    const l1Erc20BridgeContractData = CONTRACT_ADDRESSES[l1ChainId]?.zkSyncDefaultErc20Bridge;
    const l1ERC20Bridge = new Contract(
      l1Erc20BridgeContractData.address,
      l1Erc20BridgeContractData.abi,
      connectedSigner
    );
    const method = "deposit";
    const l2GasLimit = await zksync.utils.estimateDefaultBridgeDepositL2Gas(
      connectedSigner.provider,
      zkSyncProvider,
      token,
      toBN(args.amount),
      recipient,
      signerAddr,
      l2PubdataByteLimit
    );

    const params = [recipient, token, args.amount, l2GasLimit, l2PubdataByteLimit];
    const l2TransactionBaseCost = await mailboxContract.l2TransactionBaseCost(
      estimatedL1GasPrice,
      l2GasLimit,
      l2PubdataByteLimit
    );

    const _txnRequest: AugmentedTransaction = {
      contract: l1ERC20Bridge,
      chainId: args.chainId,
      method,
      args: params,
      value: l2TransactionBaseCost,
      // See comment above about gas cost multiplier.
      gasLimitMultiplier: 3,
      message: "Deposit ERC20 to ZkSync",
      mrkdwn: "Deposit ERC20 to ZkSync",
    };
    simulationResult = (await txnClient.simulate([_txnRequest]))[0];
  }

  if (simulationResult.succeed) {
    await txnClient.submit(args.chainId, [simulationResult.transaction]);
  } else {
    console.log("Simulation failed", simulationResult);
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
