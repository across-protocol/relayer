import { CHAIN_IDs } from "@across-protocol/contracts";
import { OFTBridge } from "../../src/adapter/bridges";
import { ethers } from "ethers";
import * as dotenv from "dotenv";
import { getMnemonicSigner } from "@uma/common";
import { EventSearchConfig } from "../../src/utils";

dotenv.config();

const L1OFTMessenger = "0x6C96dE32CEa08842dcc4058c14d3aaAD7Fa41dee";
const ArbitrumOFTMessenger = "0x14E4A1B13bf7F943c8ff7C51fb60FA964A298D92";

async function main() {
  const mnemonic = process.env.MNEMONIC;
  if (!mnemonic) {
    throw new Error("Please set your mnemonic in .env");
  }

  const l1Endpoint = process.env.RPC_PROVIDER_INFURA_1;
  if (!l1Endpoint) {
    throw new Error("Please set your RPC_PROVIDER_INFURA_1 in .env");
  }
  const provider = new ethers.providers.JsonRpcProvider(l1Endpoint);

  let l1Signer = getMnemonicSigner().connect(provider);

  const arbitrumEndpoint = process.env.RPC_PROVIDER_INFURA_42161;
  if (!arbitrumEndpoint) {
    throw new Error("Please set your RPC_PROVIDER_INFURA_42161 in .env");
  }
  const arbitrumProvider = new ethers.providers.JsonRpcProvider(arbitrumEndpoint);

  let bridgeObj = new OFTBridge(CHAIN_IDs.ARBITRUM, CHAIN_IDs.MAINNET, l1Signer, arbitrumProvider);

  // tx 0xb98abb3f5df29efd589da7b21b785a9ddc5e7dce182146a8e6c4ca1bddb5ec79 -- OFTSent -- Mainnet
  // tx 0xb6a48cd97d1980824d1650a373d7f61af333a52e16bc525f8d2f7034280f26ec -- OFTReceived -- Arbitrum
  const l1Token = "0xdAC17F958D2ee523a2206206994597C13D831ec7"; // USDT
  const fromAddress = ""; // we don't know `fromAddress`
  const toAddress = "0xb91F1eCC1cd62Fe73A5DFe1e663529Cd0F640d63";
  const eventConfig: EventSearchConfig = {
    fromBlock: 312030891,
    toBlock: 312030891 + 10,
  };

  let events = await bridgeObj.queryL2BridgeFinalizationEvents(l1Token, fromAddress, toAddress, eventConfig);

  for (const [key, value] of Object.entries(events)) {
    console.log(`event ${key}:`);

    for (const e of value) {
      console.log(JSON.stringify(e));
    }
  }
}

main();
