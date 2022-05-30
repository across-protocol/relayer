import { Contract, BigNumber, toBN, Event, ZERO_ADDRESS, paginatedEventQuery, runTransaction } from "../../utils";
import {
  spreadEventWithBlockNumber,
  MAX_UINT_VAL,
  assign,
  Promise,
  ERC20,
  etherscanLink,
  getNetworkName,
} from "../../utils";
import { SpokePoolClient } from "../../clients";
import { BaseAdapter, weth9Abi, ovmL1BridgeInterface, ovmL2BridgeInterface, atomicDepositorInterface } from "./";

const customL1OptimismBridgeAddresses = {
  "0x6B175474E89094C44Da98b954EedeAC495271d0F": "0x10e6593cdda8c58a1d0f14c5164b376352a55f2f", // DAI
};

const l1StandardBridgeAddressOvm = "0x99C9fc46f92E8a1c0deC1b1747d010903E884bE1";
const l1StandardBridgeAddressBoba = "0xdc1664458d2f0B6090bEa60A8793A4E66c2F1c00";

const firstL1BlockOvm = 13352477;
const firstL1BlockBoba = 13012048;

const ovmL2StandardBridgeAddress = "0x4200000000000000000000000000000000000010";
const customOvmBridgeAddresses = {
  "0x6B175474E89094C44Da98b954EedeAC495271d0F": "0x467194771dae2967aef3ecbedd3bf9a310c76c65", // DAI
};

const wethOptimismAddress = "0x4200000000000000000000000000000000000006";
const wethBobaAddress = "0xDeadDeAddeAddEAddeadDEaDDEAdDeaDDeAD0000";

const atomicDepositorAddress = "0x26eaf37ee5daf49174637bdcd2f7759a25206c34";

export class OptimismAdapter extends BaseAdapter {
  l2Gas: number;
  constructor(
    readonly logger: any,
    readonly spokePoolClients: { [chainId: number]: SpokePoolClient },
    readonly relayerAddress: string,
    readonly isOptimism: boolean
  ) {
    // Note based on if this isOptimism or not we switch the chainId and starting L1 blocks. This is critical. If done
    // wrong funds WILL be deleted in the canonical bridge (eg sending funds to Optimism with a boba L2 token).
    super(spokePoolClients, isOptimism ? 10 : 288, isOptimism ? firstL1BlockOvm : firstL1BlockBoba);
    this.l2Gas = isOptimism ? 200000 : 1300000;
  }

  async getOutstandingCrossChainTransfers(l1Tokens: string[]) {
    await this.updateBlockSearchConfig();
    this.log("Getting cross-chain txs", { l1Tokens, l1Config: this.l1SearchConfig, l2Config: this.l2SearchConfig });

    let promises = [];
    for (const l1Token of l1Tokens) {
      const l1Method = this.isWeth(l1Token) ? "ETHDepositInitiated" : "ERC20DepositInitiated";
      let l1SearchFilter = [l1Token, undefined, this.relayerAddress];
      let l2SearchFilter = [l1Token, undefined, this.relayerAddress];
      if (this.isWeth(l1Token)) {
        l1SearchFilter = [undefined, this.relayerAddress];
        l2SearchFilter = [ZERO_ADDRESS, undefined, this.relayerAddress];
      }
      const l1Bridge = this.getL1Bridge(l1Token);
      const l2Bridge = this.getL2Bridge(l1Token);
      const adapterSearchConfig = [ZERO_ADDRESS, undefined, atomicDepositorAddress];
      promises.push(
        paginatedEventQuery(l1Bridge, l1Bridge.filters[l1Method](...l1SearchFilter), this.l1SearchConfig),
        paginatedEventQuery(l2Bridge, l2Bridge.filters.DepositFinalized(...l2SearchFilter), this.l2SearchConfig),
        paginatedEventQuery(l2Bridge, l2Bridge.filters.DepositFinalized(...adapterSearchConfig), this.l2SearchConfig)
      );
    }

    const results = await Promise.all(promises, { concurrency: 4 });
    results.forEach((result, index) => {
      const l1Token = l1Tokens[Math.floor(index / 3)];
      const events = result.map((event) => {
        const eventSpread = spreadEventWithBlockNumber(event);
        return { amount: eventSpread["_amount"], to: eventSpread["_to"], blockNumber: eventSpread["blockNumber"] };
      });
      const storageName = [
        "l1DepositInitiatedEvents",
        "l2DepositFinalizedEvents",
        "l2DepositFinalizedEvents_DepositAdapter",
      ][index % 3];

      assign(this[storageName], [l1Token], events);
    });

    this.l1SearchConfig.fromBlock = this.l1SearchConfig.toBlock + 1;
    this.l2SearchConfig.fromBlock = this.l2SearchConfig.toBlock + 1;

    return this.computeOutstandingCrossChainTransfers(l1Tokens);
  }

  async sendTokenToTargetChain(l1Token, l2Token, amount) {
    let method = "depositERC20";
    let args = [l1Token, l2Token, amount, this.l2Gas, "0x"];

    // If this token is WETH(the tokenToEvent maps to the ETH method) then we modify the params to call bridgeWethToOvm
    // on the atomic depositor contract. Note that value is still 0 as this method will pull WETH from the caller.
    if (this.isWeth(l1Token)) {
      method = "bridgeWethToOvm";
      args = [this.relayerAddress, amount, this.l2Gas, this.chainId];
    }
    this.logger.debug({ at: this.getName(), message: "Bridging tokens", l1Token, l2Token, amount });
    return await runTransaction(this.logger, this.getL1TokenGateway(l1Token), method, args);
  }

  async wrapEthIfAboveThreshold(threshold: BigNumber) {
    const ethBalance = await this.getSigner(this.chainId).getBalance();
    if (ethBalance.gt(threshold)) {
      const l2Signer = this.getSigner(this.chainId);
      const l2Weth = new Contract(this.isOptimism ? wethOptimismAddress : wethBobaAddress, weth9Abi, l2Signer);
      const amountToDeposit = ethBalance.sub(threshold);
      this.logger.debug({ at: this.getName(), message: "Wrapping ETH", threshold, amountToDeposit, ethBalance });
      return await runTransaction(this.logger, l2Weth, "deposit", [], amountToDeposit);
    }
    return null;
  }

  async checkTokenApprovals(l1Tokens: string[]) {
    // We need to approve the Atomic depositor to bridge WETH to optimism via the ETH route.
    const associatedL1Bridges = l1Tokens.map((l1Token) => this.getL1TokenGateway(l1Token).address);
    await this.checkAndSendTokenApprovals(l1Tokens, associatedL1Bridges);
  }

  getL1Bridge(l1Token: string) {
    let l1BridgeAddress = this.isOptimism
      ? Object.keys(customL1OptimismBridgeAddresses).includes(l1Token)
        ? customL1OptimismBridgeAddresses[l1Token]
        : l1StandardBridgeAddressOvm
      : l1StandardBridgeAddressBoba;
    return new Contract(l1BridgeAddress, ovmL1BridgeInterface, this.getSigner(1));
  }

  getL1TokenGateway(l1Token: string) {
    if (this.isWeth(l1Token)) return new Contract(atomicDepositorAddress, atomicDepositorInterface, this.getSigner(1));
    else return this.getL1Bridge(l1Token);
  }

  getL2Bridge(l1Token: string) {
    const l2BridgeAddress = this.isOptimism
      ? Object.keys(customOvmBridgeAddresses).includes(l1Token)
        ? customOvmBridgeAddresses[l1Token]
        : ovmL2StandardBridgeAddress
      : ovmL2StandardBridgeAddress;
    return new Contract(l2BridgeAddress, ovmL2BridgeInterface, this.getSigner(this.chainId));
  }
}
