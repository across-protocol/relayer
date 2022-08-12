import { Provider } from "@ethersproject/abstract-provider";
import { Signer } from "@ethersproject/abstract-signer";
import { SpokePoolClient } from "../../clients";
import { toBN, MAX_SAFE_ALLOWANCE, Contract, ERC20, BigNumber } from "../../utils";
import { etherscanLink, getNetworkName, MAX_UINT_VAL, runTransaction } from "../../utils";

export class BaseAdapter {
  chainId: number;
  l1SearchConfig;
  l2SearchConfig;
  monitoredAddresses: string[];
  logger;

  l1DepositInitiatedEvents: { [address: string]: { [l1Token: string]: any[] } } = {};
  l2DepositFinalizedEvents: { [address: string]: { [l1Token: string]: any[] } } = {};
  l2DepositFinalizedEvents_DepositAdapter: { [address: string]: { [l1Token: string]: any[] } } = {};

  constructor(readonly spokePoolClients: { [chainId: number]: SpokePoolClient }, _chainId: number) {
    this.chainId = _chainId;
    this.l1SearchConfig = { ...this.getSearchConfig(1) };
    this.l2SearchConfig = { ...this.getSearchConfig(this.chainId) };
  }

  getSigner(chainId: number): Signer {
    return this.spokePoolClients[chainId].spokePool.signer;
  }

  getProvider(chainId: number): Provider {
    return this.spokePoolClients[chainId].spokePool.provider;
  }

  updateSearchConfigs() {
    // Update search range based on the latest data from corresponding SpokePoolClients' search ranges.
    if (this.l1SearchConfig.toBlock) this.l1SearchConfig.fromBlock = this.l1SearchConfig.toBlock + 1;
    if (this.l2SearchConfig.toBlock) this.l2SearchConfig.fromBlock = this.l2SearchConfig.toBlock + 1;
    this.l1SearchConfig.toBlock = this.spokePoolClients[1].latestBlockNumber;
    this.l2SearchConfig.toBlock = this.spokePoolClients[this.chainId].latestBlockNumber;
  }

  getSearchConfig(chainId: number) {
    return { ...this.spokePoolClients[chainId].eventSearchConfig };
  }

  async checkAndSendTokenApprovals(address: string, l1Tokens: string[], associatedL1Bridges: string[]) {
    this.log("Checking and sending token approvals", { l1Tokens, associatedL1Bridges });
    const tokensToApprove: { l1Token: Contract; targetContract: string }[] = [];
    const l1TokenContracts = l1Tokens.map((l1Token) => new Contract(l1Token, ERC20.abi, this.getSigner(1)));
    const allowances = await Promise.all(
      l1TokenContracts.map((l1TokenContract, index) => {
        // If there is not both a l1TokenContract and associatedL1Bridges[index] then return a number that wont send
        // an approval transaction. For example not every chain has a bridge contract for every token. In this case
        // we clearly dont want to send any approval transactions.
        if (l1TokenContract && associatedL1Bridges[index])
          return l1TokenContract.allowance(address, associatedL1Bridges[index]);
        else return null;
      })
    );

    allowances.forEach((allowance, index) => {
      if (allowance && allowance.lt(toBN(MAX_SAFE_ALLOWANCE)))
        tokensToApprove.push({ l1Token: l1TokenContracts[index], targetContract: associatedL1Bridges[index] });
    });

    if (tokensToApprove.length == 0) {
      this.log("No token bridge approvals needed", { l1Tokens });
      return;
    }

    let mrkdwn = "*Approval transactions:* \n";
    for (const { l1Token, targetContract } of tokensToApprove) {
      const tx = await runTransaction(this.logger, l1Token, "approve", [targetContract, MAX_UINT_VAL]);
      const receipt = await tx.wait();
      mrkdwn +=
        ` - Approved Canonical ${getNetworkName(this.chainId)} token bridge ${etherscanLink(targetContract, 1)} ` +
        `to spend ${await l1Token.symbol()} ${etherscanLink(l1Token.address, 1)} on ${getNetworkName(1)}. ` +
        `tx: ${etherscanLink(receipt.transactionHash, 1)}\n`;
    }
    this.log("Approved whitelisted tokens! 💰", { mrkdwn }, "info");
  }

  computeOutstandingCrossChainTransfers(l1Tokens: string[]): { [address: string]: { [l1Token: string]: BigNumber } } {
    const outstandingTransfers: { [address: string]: { [l1Token: string]: BigNumber } } = {};
    for (const monitoredAddress of this.monitoredAddresses) {
      if (outstandingTransfers[monitoredAddress] === undefined) {
        outstandingTransfers[monitoredAddress] = {};
      }

      for (const l1Token of l1Tokens) {
        let l2FinalizationSet = this.l2DepositFinalizedEvents[monitoredAddress][l1Token];

        if (
          this.isWeth(l1Token) &&
          this.l2DepositFinalizedEvents_DepositAdapter[monitoredAddress]?.[l1Token]?.length > 0
        ) {
          // If this is WETH and there are atomic depositor events then consider the union as the full set of
          // finalization events. We do this as the output event on L2 will show the Atomic depositor as the sender,
          // not the original sender (monitored address).
          l2FinalizationSet = [
            ...l2FinalizationSet,
            ...this.l2DepositFinalizedEvents_DepositAdapter[monitoredAddress][l1Token].filter(
              (event) => event.to === monitoredAddress
            ),
          ].sort((a, b) => a.blockNumber - b.blockNumber);
        }

        // If, however, there is either a newestFinalizedDeposit or the most recent L1 deposit time is less than 1 day
        // we can find how the current pending transactions! To do this we need to find the most recent L1 deposit event
        // that overlaps with the most recent L2 finalization event. Not all bridges emit a deposit identifier or some
        // unique way to map inputs to outputs. So the most general logic is to map the input and output amounts. Identify
        // The associated L1 Deposit event index that maps to the newest finalization event. Note that if there is none
        // this will return -1 i.e there has been no finalization event in the look back period but there is a deposit
        // this would be the case if this was the first deposit in ~1day*l2LookBackSafetyMargin blocks on the L2.
        // NOTE there is an edge case here where you have sent the same amount of funds over the bridge multiple times
        // in the last lookback period. If this is the case the below logic will consider the newest one first and disregard
        // the older transfers. The worst case if this happens is the util under counts how much is in the bridge.
        let associatedL1DepositIndex = -1;
        if (l2FinalizationSet.length > 0) {
          const newestFinalizedDeposit = l2FinalizationSet[l2FinalizationSet.length - 1];
          this.l1DepositInitiatedEvents[monitoredAddress][l1Token].forEach((l1Event, index) => {
            if (l1Event.amount.eq(newestFinalizedDeposit.amount)) {
              associatedL1DepositIndex = index;
            }
          });
        }

        // We now take a subset of all L1 Events over the interval. Remember that the L1 events are sorted by block number
        // with the most recent event last. The event set contains all deposit events that have ever happened on L1 for
        // the relayer. We know the L1 event index where which matches to the most recent L2 finalization event
        // (associatedL1DepositIndex). If we take a slice of the array from this index to the end then we have only events
        // that have occurred on L1 and have no matching event on L2 (and have happened in the last day due to the
        // previous filter). These events are deposits that must have been made on L1 but not are not yet finalized on L2.
        const l1EventsToConsider = this.l1DepositInitiatedEvents[monitoredAddress][l1Token].slice(
          associatedL1DepositIndex + 1
        );
        outstandingTransfers[monitoredAddress][l1Token] = l1EventsToConsider.reduce(
          (acc, curr) => acc.add(curr.amount),
          toBN(0)
        );
      }
    }

    return outstandingTransfers;
  }

  log(message: string, data?: any, level = "debug") {
    this.logger[level]({ at: this.getName(), message, ...data });
  }

  getName() {
    return `${getNetworkName(this.chainId)}Adapter`;
  }

  isWeth(l1Token: string) {
    return l1Token.toLowerCase() === "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2";
  }
}
