import { Contract, BigNumber, ZERO_ADDRESS, paginatedEventQuery, runTransaction, toBN } from "../../utils";
import { spreadEventWithBlockNumber, assign, Promise, winston } from "../../utils";
import { SpokePoolClient } from "../../clients";
import { BaseAdapter, weth9Abi, ovmL1BridgeInterface, ovmL2BridgeInterface, atomicDepositorInterface } from "./";

const customL1OptimismBridgeAddresses = {
  "0x6B175474E89094C44Da98b954EedeAC495271d0F": "0x10e6593cdda8c58a1d0f14c5164b376352a55f2f", // DAI
};

const l1StandardBridgeAddressOvm = "0x99C9fc46f92E8a1c0deC1b1747d010903E884bE1";
const l1StandardBridgeAddressBoba = "0xdc1664458d2f0B6090bEa60A8793A4E66c2F1c00";

const ovmL2StandardBridgeAddress = "0x4200000000000000000000000000000000000010";
const customOvmBridgeAddresses = {
  "0x6B175474E89094C44Da98b954EedeAC495271d0F": "0x467194771dae2967aef3ecbedd3bf9a310c76c65", // DAI
};

const wethOptimismAddress = "0x4200000000000000000000000000000000000006";
const wethBobaAddress = "0xDeadDeAddeAddEAddeadDEaDDEAdDeaDDeAD0000";

const atomicDepositorAddress = "0x26eaf37ee5daf49174637bdcd2f7759a25206c34";

export class OptimismAdapter extends BaseAdapter {
  public l2Gas: number;
  constructor(
    readonly logger: winston.Logger,
    readonly spokePoolClients: { [chainId: number]: SpokePoolClient },
    readonly monitoredAddresses: string[],
    readonly isOptimism: boolean,
    // Optional sender address where the cross chain transfers originate from. This is useful for the use case of
    // monitoring transfers from HubPool to SpokePools where the sender is HubPool.
    readonly senderAddress?: string
  ) {
    // Note based on if this isOptimism or not we switch the chainId and starting L1 blocks. This is critical. If done
    // wrong funds WILL be deleted in the canonical bridge (eg sending funds to Optimism with a boba L2 token).
    super(spokePoolClients, isOptimism ? 10 : 288);
    this.l2Gas = isOptimism ? 200000 : 1300000;
  }

  async getOutstandingCrossChainTransfers(l1Tokens: string[]) {
    this.updateSearchConfigs();
    this.log("Getting cross-chain txs", { l1Tokens, l1Config: this.l1SearchConfig, l2Config: this.l2SearchConfig });

    const promises = [];
    // Fetch bridge events for all monitored addresses.
    for (const monitoredAddress of this.monitoredAddresses) {
      for (const l1Token of l1Tokens) {
        const l1Method = this.isWeth(l1Token) ? "ETHDepositInitiated" : "ERC20DepositInitiated";
        let l1SearchFilter = [l1Token, undefined, monitoredAddress];
        let l2SearchFilter = [l1Token, undefined, monitoredAddress];
        if (this.isWeth(l1Token)) {
          l1SearchFilter = [undefined, monitoredAddress];
          l2SearchFilter = [ZERO_ADDRESS, undefined, monitoredAddress];
        }
        const l1Bridge = this.getL1Bridge(l1Token);
        const l2Bridge = this.getL2Bridge(l1Token);
        // Transfers might have come from the monitored address itself or another sender address (if specified).
        const senderAddress = this.senderAddress || atomicDepositorAddress;
        const adapterSearchConfig = [ZERO_ADDRESS, undefined, senderAddress];
        promises.push(
          paginatedEventQuery(l1Bridge, l1Bridge.filters[l1Method](...l1SearchFilter), this.l1SearchConfig),
          paginatedEventQuery(l2Bridge, l2Bridge.filters.DepositFinalized(...l2SearchFilter), this.l2SearchConfig),
          paginatedEventQuery(l2Bridge, l2Bridge.filters.DepositFinalized(...adapterSearchConfig), this.l2SearchConfig)
        );
      }
    }

    const results = await Promise.all(promises, { concurrency: 4 });

    // 3 events per token.
    const numEventsPerMonitoredAddress = 3 * l1Tokens.length;

    // Segregate the events list by monitored address.
    const resultsByMonitoredAddress = Object.fromEntries(
      this.monitoredAddresses.map((monitoredAddress, index) => {
        const start = index * numEventsPerMonitoredAddress;
        return [monitoredAddress, results.slice(start, start + numEventsPerMonitoredAddress + 1)];
      })
    );

    // Process events for each monitored address.
    for (const monitoredAddress of this.monitoredAddresses) {
      const eventsToProcess = resultsByMonitoredAddress[monitoredAddress];
      // The logic below takes the results from the promises and spreads them into the l1DepositInitiatedEvents,
      // l2DepositFinalizedEvents and l2DepositFinalizedEvents_DepositAdapter state from the BaseAdapter.
      eventsToProcess.forEach((result, index) => {
        const l1Token = l1Tokens[Math.floor(index / 3)];
        const events = result.map((event) => {
          const eventSpread = spreadEventWithBlockNumber(event);
          return {
            amount: eventSpread["_amount"],
            to: eventSpread["_to"],
            ...eventSpread,
          };
        });
        const eventsStorage = [
          this.l1DepositInitiatedEvents,
          this.l2DepositFinalizedEvents,
          this.l2DepositFinalizedEvents_DepositAdapter,
        ][index % 3];

        assign(eventsStorage, [monitoredAddress, l1Token], events);
      });
    }

    this.l1SearchConfig.fromBlock = this.l1SearchConfig.toBlock + 1;
    this.l2SearchConfig.fromBlock = this.l2SearchConfig.toBlock + 1;

    return this.computeOutstandingCrossChainTransfers(l1Tokens);
  }

  async sendTokenToTargetChain(address: string, l1Token: string, l2Token: string, amount: BigNumber) {
    let method = "depositERC20";
    let args = [l1Token, l2Token, amount, this.l2Gas, "0x"];

    // If this token is WETH(the tokenToEvent maps to the ETH method) then we modify the params to call bridgeWethToOvm
    // on the atomic depositor contract. Note that value is still 0 as this method will pull WETH from the caller.
    if (this.isWeth(l1Token)) {
      method = "bridgeWethToOvm";
      args = [address, amount, this.l2Gas, this.chainId];
    }
    this.logger.debug({ at: this.getName(), message: "Bridging tokens", l1Token, l2Token, amount });

    // For some reason ethers will often underestimate the amount of gas Boba bridge needs for a deposit. If this
    // OptimismAdapter is connected to Boba then manually set the gasLimit to 250k which works consistently.
    if (this.chainId === 288)
      return await runTransaction(this.logger, this.getL1TokenGateway(l1Token), method, args, toBN(0), toBN(250000));
    else return await runTransaction(this.logger, this.getL1TokenGateway(l1Token), method, args);
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

  async checkTokenApprovals(address: string, l1Tokens: string[]) {
    // We need to approve the Atomic depositor to bridge WETH to optimism via the ETH route.
    const associatedL1Bridges = l1Tokens.map((l1Token) => this.getL1TokenGateway(l1Token).address);
    await this.checkAndSendTokenApprovals(address, l1Tokens, associatedL1Bridges);
  }

  getL1Bridge(l1Token: string) {
    const l1BridgeAddress = this.isOptimism
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
