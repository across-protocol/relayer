import { promises as fs } from "fs";
import { ethers, Contract, providers } from "ethers";
import { Provider as zksProvider, utils as zkUtils, Wallet as zkWallet } from "zksync-web3";
import { config } from "dotenv";

const rpcUrl = ""; // Infura mainnet RPC URL

async function run(): Promise<void> {
  const url = "https://mainnet.era.zksync.io";
  const provider = new zksProvider(url);
  const wallet = zkWallet.fromMnemonic(process.env.MNEMONIC).connect(provider);

  const erc20BridgeABIs = await provider.getDefaultBridgeAddresses();
  const ethProvider = new providers.StaticJsonRpcProvider(rpcUrl);

  const zksL1ERC20Bridge = new Contract(erc20BridgeABIs.erc20L1, zkUtils.L1_BRIDGE_ABI, ethProvider);
  const zksL2ERC20Bridge = new Contract(erc20BridgeABIs.erc20L2, zkUtils.L2_BRIDGE_ABI, wallet);

  await zksL1ERC20Bridge.provider.getBlock("latest"); // seems to be necessary...

  const l1Token = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48"; // mainnet USDC
  const l2Token = await zksL1ERC20Bridge.l2TokenAddress(l1Token);

  const _erc20ABI = await fs.readFile("./scripts/erc20ABI.json", "utf8");
  const erc20ABI = JSON.parse(_erc20ABI);

  const erc20 = new Contract(l2Token, erc20ABI, provider);
  const decimals = await erc20.decimals();
  let balance = await erc20.balanceOf(wallet.address);
  const amount = ethers.utils.parseUnits("1", decimals);
  while (balance.gt(amount)) {
    const withdrawal = await zksL2ERC20Bridge.withdraw(wallet.address, erc20.address, amount);
    console.log(`Withdrawal transaction: ${withdrawal.hash}.`);
    await withdrawal.wait();
    balance = await erc20.balanceOf(wallet.address);
    console.log(`Balance is now: ${balance}`);
  }
}

if (require.main === module) {
  config();

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
