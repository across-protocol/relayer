import { SpokePoolClient } from "../../clients";
import { toBN, MAX_SAFE_ALLOWANCE, Contract, ERC20, BigNumber } from "../../utils";
import { etherscanLink, getNetworkName, MAX_UINT_VAL, runTransaction } from "../../utils";

export class BaseAdapter {
  chainId: number;
  l1SearchConfig;
  l2SearchConfig;
  relayerAddress;
  logger;

  l1DepositInitiatedEvents: { [l1Token: string]: any[] } = {};
  l2DepositFinalizedEvents: { [l1Token: string]: any[] } = {};
  l2DepositFinalizedEvents_DepositAdapter: { [l1Token: string]: any[] } = {};

  // In worst case deposits MUST conclude within 24 hours. Used to optimize how many event queries we need to do on
  // some L2s that restrict large loobacks.
  depositEvalTime = 24 * 60 * 60;

  firstEvaluatedL1BlockNumber: number;
  constructor(
    readonly spokePoolClients: { [chainId: number]: SpokePoolClient },
    _chainId: number,
    readonly l1FromBlock: number
  ) {
    this.chainId = _chainId;
    this.l1SearchConfig = { ...this.getSearchConfig(1), fromBlock: l1FromBlock };
    this.l2SearchConfig = { ...this.getSearchConfig(this.chainId), fromBlock: 0 };
  }

  getSigner(chainId: number) {
    return this.spokePoolClients[chainId].spokePool.signer;
  }

  getProvider(chainId: number) {
    return this.spokePoolClients[chainId].spokePool.provider;
  }

  getSearchConfig(chainId: number) {
    return this.spokePoolClients[chainId].eventSearchConfig;
  }

  async updateBlockSearchConfig() {
    //todo: swap this to pulling spokePoolClient.latestBlockNumber.
    const [l1BlockNumber, l2BlockNumber] = await Promise.all([
      this.getProvider(1).getBlockNumber(),
      this.getProvider(this.chainId).getBlockNumber(),
    ]);

    this.l1SearchConfig.toBlock = l1BlockNumber;
    this.l2SearchConfig.toBlock = l2BlockNumber;

    this.l2SearchConfig.fromBlock = this.l2SearchConfig.toBlock - this.depositEvalTime / this.avgBlockTime();
  }

  async checkAndSendTokenApprovals(l1Tokens: string[], associatedL1Bridges: string[]) {
    this.log("Checking and sending token approvals", { l1Tokens, associatedL1Bridges });
    const tokensToApprove: { l1Token: any; targetContract: string }[] = [];
    const l1TokenContracts = l1Tokens.map((l1Token) => new Contract(l1Token, ERC20.abi, this.getSigner(1)));
    const allowances = await Promise.all(
      l1TokenContracts.map((l1TokenContract, index) => {
        // If there is not both a l1TokenContract and associatedL1Bridges[index] then return a number that wont send
        // an approval transaction. For example not every chain has a bridge contract for every token. In this case
        // we clearly dont want to send any approval transactions.
        if (l1TokenContract && associatedL1Bridges[index])
          return l1TokenContract.allowance(this.relayerAddress, associatedL1Bridges[index]);
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

  computeOutstandingCrossChainTransfers(l1Tokens: string[]): { [l1Token: string]: BigNumber } {
    let outstandingTransfers = {};
    for (const l1Token of l1Tokens) {
      let l2FinalizationSet = this.l2DepositFinalizedEvents[l1Token];
      if (this.isWeth(l1Token) && this.l2DepositFinalizedEvents_DepositAdapter?.[l1Token]?.length > 0)
        l2FinalizationSet = [
          ...l2FinalizationSet,
          ...this.l2DepositFinalizedEvents_DepositAdapter[l1Token].filter((event) => event.to === this.relayerAddress),
        ].sort((a, b) => a.blockNumber - b.blockNumber);

      const newestFinalizedAmount = l2FinalizationSet[l2FinalizationSet.length - 1];
      const newestDeposit = this.l1DepositInitiatedEvents[l1Token][this.l1DepositInitiatedEvents[l1Token].length - 1];
      if (
        !newestFinalizedAmount &&
        newestDeposit.blockNumber < this.l1SearchConfig.toBlock - this.depositEvalTime / this.avgBlockTime(1)
      ) {
        outstandingTransfers[l1Token] = toBN(0);
        continue;
      }

      let associatedL1DepositIndex = -1;
      if (newestFinalizedAmount)
        this.l1DepositInitiatedEvents[l1Token].forEach((l1Event, index) => {
          if (l1Event.amount.eq(newestFinalizedAmount.amount)) {
            associatedL1DepositIndex = index;
            return;
          }
        });

      const l1EventsToConsider = this.l1DepositInitiatedEvents[l1Token].slice(associatedL1DepositIndex + 1);
      const totalDepositsOutstanding = l1EventsToConsider.reduce((acc, curr) => acc.add(curr.amount), toBN(0));
      outstandingTransfers[l1Token] = totalDepositsOutstanding;
    }

    return outstandingTransfers;
  }

  log(message: string, data?: any, level: string = "debug") {
    this.logger[level]({ at: this.getName(), message, ...data });
  }

  getName() {
    return `${getNetworkName(this.chainId)}Adapter`;
  }

  isWeth(l1Token: string) {
    return l1Token == "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";
  }

  avgBlockTime(chainId: number = this.chainId) {
    if (chainId == 1) return 15;
    if (chainId == 10) return 0.1;
    if (chainId == 137) return 1;
    if (chainId == 288) return 0.1;
    if (chainId == 42161) return 0.1;
  }
}
