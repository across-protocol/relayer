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

  depositEvalTime = 24 * 60 * 60; // Consider all deposit finalization events over the last 1 day.
  l2LookBackSafetyMargin = 5; // The pending transfers util can accommodate up to this multiplier

  constructor(
    readonly spokePoolClients: { [chainId: number]: SpokePoolClient },
    _chainId: number,
    readonly l1FromBlock: number
  ) {
    this.chainId = _chainId;
    this.l1SearchConfig = { ...this.getSearchConfig(1), fromBlock: l1FromBlock };
    this.l2SearchConfig = { ...this.getSearchConfig(this.chainId), fromBlock: 0 };
  }

  getSigner(chainId: number): Signer {
    return this.spokePoolClients[chainId].spokePool.signer;
  }

  getProvider(chainId: number): Provider {
    return this.spokePoolClients[chainId].spokePool.provider;
  }

  getSearchConfig(chainId: number) {
    return this.spokePoolClients[chainId].eventSearchConfig;
  }

  async updateBlockSearchConfig() {
    // todo: swap this to pulling spokePoolClient.latestBlockNumber.
    const [l1BlockNumber, l2BlockNumber] = await Promise.all([
      this.getProvider(1).getBlockNumber(),
      this.getProvider(this.chainId).getBlockNumber(),
    ]);

    this.l1SearchConfig.toBlock = l1BlockNumber;
    this.l2SearchConfig.toBlock = l2BlockNumber;

    this.l2SearchConfig.fromBlock = Math.floor(
      this.l2SearchConfig.toBlock - (this.depositEvalTime / this.avgBlockTime()) * this.l2LookBackSafetyMargin
    );
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
          // If this is WETH and there are atomic depositor events then consider the union as the ful set of finalization
          // events. We do this as the output event on L2 will show the Atomic depositor as the sender, not the relayer.
          l2FinalizationSet = [
            ...l2FinalizationSet,
            ...this.l2DepositFinalizedEvents_DepositAdapter[monitoredAddress][l1Token].filter(
              (event) => event.to === monitoredAddress
            ),
          ].sort((a, b) => a.blockNumber - b.blockNumber);
        }

        // Find the most recent L2 finalization event and most recent deposit event.
        const newestFinalizedDeposit = l2FinalizationSet[l2FinalizationSet.length - 1];
        const newestInitializedDeposit =
          this.l1DepositInitiatedEvents[monitoredAddress][l1Token][
            this.l1DepositInitiatedEvents[monitoredAddress][l1Token].length - 1
          ];

        // If there is no newest finalization event (i.e over the block window searched there is no event) and the most
        // recent L1 block is older than 1 day then there must be no outstanding transfers. Remember that the range that
        // the L2 events are searched over is ~1 day of events, with a safety buffer l2LookBackSafetyMargin(x3). As long as
        // the time over which the L2 blocks are search is greater the l1 period (~5 days > ~1 day) then the check below
        // will correctly return 0 for no outstanding transfers in the last period. In the event blocks are produced
        // much faster on L2 this check can fail! this is why we have the l2LookBackSafetyMargin to accommodate variations
        // in the L2 block time. Note that if this does not hold true the logic will incorrectly determine the cross-chain
        // transfer amount. Alternatively, if there no newestInitializedDeposit then we have never made a L1 deposit.
        const approx12HourAgoL1 = this.l1SearchConfig.toBlock - this.depositEvalTime / this.avgBlockTime(1) / 2;
        if (
          (!newestFinalizedDeposit && newestInitializedDeposit?.blockNumber < approx12HourAgoL1) ||
          !newestInitializedDeposit // If there has never been any finalized deposits.
        ) {
          outstandingTransfers[monitoredAddress][l1Token] = toBN(0);
          continue;
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
        if (newestFinalizedDeposit) {
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
        let l1EventsToConsider = this.l1DepositInitiatedEvents[monitoredAddress][l1Token].slice(
          associatedL1DepositIndex + 1
        );

        // If we have no L2 finalization events to consider then there is one additional bit of filter we need to do:
        // remove any L1 events that are older than ~ 1 day. This is because we dont know from which L1 event to search
        // from as we could not match an associatedL1DepositIndex. However we know that if there are any events that
        // are older than 1 day ago they are invalid as they would have finalized in this period of time and must have
        // matched onto the newest event in the l2FinalizationSet and so they should be disregarded.
        if (!newestFinalizedDeposit)
          l1EventsToConsider = l1EventsToConsider.filter((l1Event) => l1Event.blockNumber > approx12HourAgoL1);

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

  // Define some very rough heuristics for the average block time per chain.
  avgBlockTime(chainId: number = this.chainId) {
    if (chainId == 1) return 14; // 1 block every 13.5 seconds.
    if (chainId == 10) return 0.1; // assume worst case of 10 blocks every second.
    if (chainId == 137) return 1; // one block every 2 seconds.
    if (chainId == 288) return 30; // one block every 30 seconds.
    if (chainId == 42161) return 0.1; // assume worst case of 10 blocks every second.
  }
}
