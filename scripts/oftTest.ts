import { CHAIN_IDs, TOKEN_SYMBOLS_MAP } from "@across-protocol/contracts";
import { OFTBridge } from "../src/adapter/bridges";
import { ethers, Signer, Contract, BigNumber } from "ethers";
import * as dotenv from "dotenv";
import { getMnemonicSigner } from "@uma/common";
import { EventSearchConfig } from "../src/utils";
import { Provider } from "zksync-ethers";

import { IOFT__factory } from "@across-protocol/contracts";

import {
  IOFT,
  SendParamStruct,
  MessagingFeeStruct,
} from "@across-protocol/contracts/typechain/@layerzerolabs/oft-evm/contracts/interfaces/IOFT";

dotenv.config();

const MAINNET_IOFT = "0x6C96dE32CEa08842dcc4058c14d3aaAD7Fa41dee";
const ARBITRUM_IOFT = "0x14E4A1B13bf7F943c8ff7C51fb60FA964A298D92";

const USDT = TOKEN_SYMBOLS_MAP.USDT;

// ERC20 ABI for approval function
const ERC20_ABI = [
  "function approve(address spender, uint256 amount) external returns (bool)",
  "function allowance(address owner, address spender) external view returns (uint256)",
];

/**
 * Creates and returns a signer connected to the mainnet provider
 */
function createMainnetSigner(): Signer {
  const mnemonic = process.env.MNEMONIC;
  if (!mnemonic) {
    throw new Error("Please set your mnemonic in .env");
  }

  // Get RPC URL from environment variable
  const mainnetRpc = process.env.IHOR_DEV_MAINNET_RPC;
  if (!mainnetRpc) {
    throw new Error("Please set IHOR_DEV_MAINNET_RPC in .env");
  }

  const mainnetProvider = new ethers.providers.JsonRpcProvider(mainnetRpc);
  return getMnemonicSigner().connect(mainnetProvider);
}

/**
 * Creates an OFTBridge adapter with the provided signer
 */
function createOFTBridgeAdapter(mainnetSigner?: Signer): OFTBridge {
  if (!mainnetSigner) {
    mainnetSigner = createMainnetSigner();
  }

  // Get RPC URL from environment variable
  const arbitrumRpc = process.env.IHOR_DEV_ARBITRUM_RPC;
  if (!arbitrumRpc) {
    throw new Error("Please set IHOR_DEV_ARBITRUM_RPC in .env");
  }

  const arbitrumProvider = new ethers.providers.JsonRpcProvider(arbitrumRpc);

  return new OFTBridge(CHAIN_IDs.ARBITRUM, CHAIN_IDs.MAINNET, mainnetSigner, arbitrumProvider);
}

/**
 * Approves the OFT contract to spend tokens on behalf of the signer
 */
async function approveTokenForOFT(
  signer: Signer,
  tokenAddress: string,
  spenderAddress: string,
  amount: ethers.BigNumber
): Promise<ethers.ContractReceipt> {
  console.log(`Approving ${ethers.utils.formatUnits(amount, 6)} USDT for OFT contract...`);

  // Create token contract instance
  const tokenContract = new ethers.Contract(tokenAddress, ERC20_ABI, signer);

  // Check current allowance
  const signerAddress = await signer.getAddress();
  const currentAllowance = await tokenContract.allowance(signerAddress, spenderAddress);

  if (currentAllowance.gte(amount)) {
    console.log(`Approval not needed. Current allowance: ${ethers.utils.formatUnits(currentAllowance, 6)} USDT`);
    return Promise.resolve({} as ethers.ContractReceipt);
  }

  // Send approval transaction
  console.log(
    `Current allowance: ${ethers.utils.formatUnits(currentAllowance, 6)} USDT. Sending approval transaction...`
  );
  const tx = await tokenContract.approve(spenderAddress, amount);

  console.log(`Approval transaction sent! Hash: ${tx.hash}`);
  console.log("Waiting for confirmation...");

  // Wait for transaction to be mined
  const receipt = await tx.wait();
  console.log(`Approval confirmed in block ${receipt.blockNumber}`);

  return receipt;
}

// checked ✅
async function testQueryOFTReceived() {
  const tx = "0xb0954cdb55474e112edef3321b39552e7c4a9acffc03e7f65e608f67f266f4f2";
  const txBlock = 312609233;
  const txFromAddress = "";
  const txToAddress = "0xBf7375a21f0B9cC837f51759b68903B79BeE5B10"; // todo: checksummed ok?

  const bridgeObj = createOFTBridgeAdapter();

  const l1Token = USDT.addresses[CHAIN_IDs.MAINNET];
  const eventConfig: EventSearchConfig = {
    fromBlock: txBlock - 1,
    toBlock: txBlock + 9,
  };

  const events = await bridgeObj.queryL2BridgeFinalizationEvents(l1Token, txFromAddress, txToAddress, eventConfig);

  for (const [key, value] of Object.entries(events)) {
    console.log(`event ${key}:`);

    for (const e of value) {
      console.log(JSON.stringify(e));
    }
  }
}

// checked ✅
async function testQueryOFTSent() {
  const tx = "0xe7b0b71ec383434d2aef192798837a88acde40a4f17a8c07a7cb307c411f7245";
  const txBlock = 21984599;
  const txFromAddress = "0x2Ce910fBba65B454bBAf6A18c952A70f3bcd8299";
  const txToAddress = "0x2ce910fbba65b454bbaf6a18c952a70f3bcd8299";

  const bridgeObj = createOFTBridgeAdapter();

  const l1Token = USDT.addresses[CHAIN_IDs.MAINNET];
  const eventConfig: EventSearchConfig = {
    fromBlock: txBlock - 1,
    toBlock: txBlock + 9,
  };

  const events = await bridgeObj.queryL1BridgeInitiationEvents(l1Token, txFromAddress, txToAddress, eventConfig);

  for (const [key, value] of Object.entries(events)) {
    console.log(`event ${key}:`);

    for (const e of value) {
      console.log(JSON.stringify(e));
    }
  }
}

// checked ✅
/**
 * Sends 1 USDT from Ethereum to Arbitrum using the OFTBridge
 */
async function sendUSDTToArbitrum() {
  try {
    console.log("Creating signer and OFTBridge adapter...");
    const signer = createMainnetSigner();
    const bridgeObj = createOFTBridgeAdapter(signer);

    // Get the signer's address
    const fromAddress = await signer.getAddress();
    console.log(`Sending from address: ${fromAddress}`);

    // Destination address on Arbitrum (using the same address as the sender)
    const toAddress = fromAddress;

    // Get USDT token address on Ethereum
    const l1Token = USDT.addresses[CHAIN_IDs.MAINNET];
    const l2Token = USDT.addresses[CHAIN_IDs.ARBITRUM];

    // Amount to send: 1 USDT (with 6 decimals)
    const amount = ethers.utils.parseUnits("1.0", 6);

    // Get the OFT contract address for USDT
    const oftContractAddress = MAINNET_IOFT; // This is the OFT contract for USDT on Ethereum

    // First, approve the OFT contract to spend USDT
    await approveTokenForOFT(signer, l1Token, oftContractAddress, amount);

    console.log(
      `Preparing transaction to send ${ethers.utils.formatUnits(amount, 6)} USDT to ${toAddress} on Arbitrum...`
    );

    // Construct the transaction
    const txDetails = await bridgeObj.constructL1ToL2Txn(toAddress, l1Token, l2Token, amount);

    console.log("Transaction details:", {
      contract: txDetails.contract.address,
      method: txDetails.method,
      args: txDetails.args,
      value: txDetails.value ? ethers.utils.formatEther(txDetails.value) + " ETH" : "0 ETH",
    });

    // Create an IOFT contract instance with the correct interface
    const oftContract = new ethers.Contract(txDetails.contract.address, IOFT__factory.abi, signer);

    // Extract the arguments from txDetails
    if (txDetails.method === "send" && txDetails.args.length >= 3) {
      const sendParam = txDetails.args[0] as SendParamStruct;
      const fee = txDetails.args[1] as MessagingFeeStruct;
      const refundAddress = txDetails.args[2] as string;

      console.log("SendParam:", sendParam);
      console.log("Fee:", fee);
      console.log("Refund Address:", refundAddress);

      // To actually send the transaction, uncomment the following:

      console.log("Sending transaction using IOFT interface with manual gas limit...");

      // Set a manual gas limit to bypass estimateGas
      const manualGasLimit = 500000; // A reasonable gas limit for this type of transaction

      try {
        // Create a transaction object with overrides
        const txRequest = await oftContract.populateTransaction.send(sendParam, fee, refundAddress, {
          value: txDetails.value || ethers.constants.Zero,
          gasLimit: manualGasLimit,
        });

        console.log("Transaction request:", txRequest);

        // Send the transaction directly using the signer
        const tx = await signer.sendTransaction(txRequest);

        console.log(`Transaction sent! Hash: ${tx.hash}`);
        console.log("Waiting for confirmation...");

        const receipt = await tx.wait();
        console.log(`Transaction confirmed in block ${receipt.blockNumber}`);
      } catch (error) {
        console.error("Error sending transaction:", error);

        // If the above method fails, try an even more direct approach
        console.log("Trying alternative method with direct transaction...");

        // Create a direct transaction object
        const directTxRequest = {
          to: txDetails.contract.address,
          value: txDetails.value || ethers.constants.Zero,
          gasLimit: manualGasLimit,
          data: oftContract.interface.encodeFunctionData("send", [sendParam, fee, refundAddress]),
        };

        console.log("Direct transaction request:", directTxRequest);

        try {
          const directTx = await signer.sendTransaction(directTxRequest);
          console.log(`Direct transaction sent! Hash: ${directTx.hash}`);
          console.log("Waiting for confirmation...");

          const directReceipt = await directTx.wait();
          console.log(`Direct transaction confirmed in block ${directReceipt.blockNumber}`);
        } catch (directError) {
          console.error("Error sending direct transaction:", directError);
        }
      }
    } else {
      console.error(`Unexpected method or arguments: ${txDetails.method}, args length: ${txDetails.args.length}`);
    }
  } catch (error) {
    console.error("Error sending USDT to Arbitrum:", error);
  }
}

// testQueryOFTReceived();
// testQueryOFTSent();
sendUSDTToArbitrum();
