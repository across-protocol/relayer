import { Contract, BigNumber, toBN, Event, ZERO_ADDRESS, paginatedEventQuery, runTransaction } from "../../utils";
import { MAX_SAFE_ALLOWANCE, MAX_UINT_VAL, assign, Promise, ERC20, etherscanLink, getNetworkName } from "../../utils";
import { SpokePoolClient } from "../../clients";
import { weth9Abi, optimismL1BridgeInterface, optimismL2BridgeInterface } from "./ContractInterfaces";

import { BaseAdapter } from "./BaseAdapter";

const customL1BridgeAddresses = {
  "0x6B175474E89094C44Da98b954EedeAC495271d0F": "0x10e6593cdda8c58a1d0f14c5164b376352a55f2f", // DAI
};

const l1StandardBridgeAddressOvm = "0x99C9fc46f92E8a1c0deC1b1747d010903E884bE1";
const l1StandardBridgeAddressBoba = "0xdc1664458d2f0B6090bEa60A8793A4E66c2F1c00";

const firstL1BlockOvm = 13352477;
const firstL1BlockBoba = 13012048;

const tokenToEvent = {
  "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48": "ERC20DepositInitiated", // USDC
  "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2": "ETHDepositInitiated", // WETH
  "0x6B175474E89094C44Da98b954EedeAC495271d0F": "ERC20DepositInitiated", // DAI
  "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599": "ERC20DepositInitiated", // WBTC
};

const ovmL2StandardBridgeAddress = "0x4200000000000000000000000000000000000010";
const customOvmBridgeAddresses = {
  "0x6B175474E89094C44Da98b954EedeAC495271d0F": "0x467194771dae2967aef3ecbedd3bf9a310c76c65", // DAI
};

const wethOptimismAddress = "0x4200000000000000000000000000000000000006";
const wethBobaAddress = "0xDeadDeAddeAddEAddeadDEaDDEAdDeaDDeAD0000";

const l2Gas = 200000;

export class OptimismAdapter extends BaseAdapter {
  constructor(
    readonly logger: any,
    readonly spokePoolClients: { [chainId: number]: SpokePoolClient },
    readonly relayerAddress: string,
    readonly isOptimism: boolean
  ) {
    super(spokePoolClients);
    this.chainId = isOptimism ? 10 : 288;
    this.l1SearchConfig = { ...this.getSearchConfig(1), fromBlock: isOptimism ? firstL1BlockOvm : firstL1BlockBoba };
    this.l2SearchConfig = { ...this.getSearchConfig(this.chainId), fromBlock: 0 };
  }

  async getOutstandingCrossChainTransfers(l1Tokens: string[]) {
    await this.updateFromBlockSearchConfig();
    this.logger.debug({ at: this.getName(), message: "Fetching outstanding transfers", l1Tokens });

    let promises = [];
    for (const l1Token of l1Tokens) {
      const l1Method = tokenToEvent[l1Token];
      const isErc20Token = l1Method == "ERC20DepositInitiated";
      const l1SearchFilter = isErc20Token ? [l1Token, undefined, this.relayerAddress] : [this.relayerAddress];
      const l2SearchFilter = isErc20Token
        ? [l1Token, undefined, this.relayerAddress]
        : [ZERO_ADDRESS, undefined, this.relayerAddress];
      const l1Bridge = this.getL1Bridge(l1Token);
      const l2Bridge = this.getL2Bridge(l1Token);
      promises.push(
        paginatedEventQuery(l1Bridge, l1Bridge.filters[l1Method](...l1SearchFilter), this.l1SearchConfig),
        paginatedEventQuery(l2Bridge, l2Bridge.filters.DepositFinalized(...l2SearchFilter), this.l2SearchConfig)
      );
    }

    const results = await Promise.all(promises, { concurrency: 1 });
    results.forEach((result, index) => {
      const l1Token = l1Tokens[Math.floor(index / 2)];
      const storageName = index % 2 === 0 ? "l1DepositInitiatedEvents" : "l2DepositFinalizedEvents";
      assign(this[storageName], [l1Token], result);
    });

    let outstandingTransfers = {};
    for (const l1Token of l1Tokens) {
      const totalDepositsInitiated = this.l1DepositInitiatedEvents[l1Token]
        .map((event: Event) => event.args._amount)
        .reduce((acc, curr) => acc.add(curr), toBN(0));

      const totalDepositsFinalized = this.l2DepositFinalizedEvents[l1Token]
        .map((event: Event) => event.args._amount)
        .reduce((acc, curr) => acc.add(curr), toBN(0));

      outstandingTransfers[l1Token] = totalDepositsInitiated.sub(totalDepositsFinalized);
    }

    this.l1SearchConfig.fromBlock = this.l1SearchConfig.toBlock + 1;
    this.l2SearchConfig.fromBlock = this.l2SearchConfig.toBlock + 1;
    return outstandingTransfers;
  }

  async sendTokenToTargetChain(l1Token, l2Token, amount) {
    const l1Bridge = this.getL1Bridge(l1Token);

    let value = toBN(0);
    let method = "depositERC20";
    let args = [l1Token, l2Token, amount, l2Gas, "0x"];

    // If this token is WETH(the tokenToEvent maps to the ETH method) then we modify the params to deposit ETH.
    const isEth = tokenToEvent[l1Token] == "ETHDepositInitiated";

    if (isEth) {
      value = amount;
      method = "depositETH";
      args = [l2Gas, "0x"];
    }
    this.logger.debug({ at: this.getName(), message: "Bridging tokens", l1Token, l2Token, amount });
    return await runTransaction(this.logger, l1Bridge, method, args, value);
  }

  async wrapEthIfAboveThreshold(threshold) {
    const ethBalance = await this.getSigner(1).getBalance();
    if (ethBalance.gt(threshold)) {
      const l2Signer = this.getSigner(this.chainId);
      const l2Weth = new Contract(this.isOptimism ? wethOptimismAddress : wethBobaAddress, weth9Abi, l2Signer);
      const amountToDeposit = ethBalance.sub(threshold);
      this.logger.debug({ at: this.getName(), message: "Wrapping ETH", threshold, amountToDeposit, ethBalance });
      return await runTransaction(this.logger, l2Weth, "deposit", [], amountToDeposit);
    }
    return null;
  }
  getName() {
    return this.isOptimism ? "OptimismAdapter" : "BobaAdapter";
  }

  async checkTokenApprovals(l1Tokens: string[]) {
    // We dont need to do approvals for weth as optimism sends ETH over the bridge.
    l1Tokens = l1Tokens.filter((l1Token) => tokenToEvent[l1Token] != "ETHDepositInitiated");
    const associatedL1Bridges = l1Tokens.map((l1Token) => this.getL1Bridge(l1Token).address);
    await this.checkAndSendTokenApprovals(l1Tokens, associatedL1Bridges);
  }

  getL1Bridge(l1Token: string) {
    const l1BridgeAddress = this.isOptimism
      ? Object.keys(customL1BridgeAddresses).includes(l1Token)
        ? customL1BridgeAddresses[l1Token]
        : l1StandardBridgeAddressOvm
      : l1StandardBridgeAddressBoba;
    return new Contract(l1BridgeAddress, optimismL1BridgeInterface, this.getProvider(1));
  }

  getL2Bridge(l1Token: string) {
    const l2BridgeAddress = this.isOptimism
      ? Object.keys(customOvmBridgeAddresses).includes(l1Token)
        ? customOvmBridgeAddresses[l1Token]
        : ovmL2StandardBridgeAddress
      : ovmL2StandardBridgeAddress;
    return new Contract(l2BridgeAddress, optimismL2BridgeInterface, this.getProvider(this.chainId));
  }
}
