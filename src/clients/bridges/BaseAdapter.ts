import { Provider } from "@ethersproject/abstract-provider";
import { Signer } from "@ethersproject/abstract-signer";
import { SpokePoolClient } from "../../clients";
import { toBN, MAX_SAFE_ALLOWANCE, Contract, ERC20, BigNumber } from "../../utils";
import { etherscanLink, getNetworkName, MAX_UINT_VAL, runTransaction } from "../../utils";
import { OutstandingTransfers } from "../../interfaces/Bridge";

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
    // This needs to be called before fetching any events because spokePoolClients need to be updated first so
    // latestBlockNumber is defined.
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

  computeOutstandingCrossChainTransfers(l1Tokens: string[]): OutstandingTransfers {
    const outstandingTransfers: OutstandingTransfers = {};

    for (const monitoredAddress of this.monitoredAddresses) {
      // Skip if there are no deposit events for this address at all.
      if (this.l1DepositInitiatedEvents[monitoredAddress] === undefined) continue;

      if (outstandingTransfers[monitoredAddress] === undefined) {
        outstandingTransfers[monitoredAddress] = {};
      }
      if (this.l2DepositFinalizedEvents[monitoredAddress] === undefined) {
        this.l2DepositFinalizedEvents[monitoredAddress] = {};
      }

      for (const l1Token of l1Tokens) {
        // Skip if there has been no deposits for this token.
        if (this.l1DepositInitiatedEvents[monitoredAddress][l1Token] === undefined) continue;

        // It's okay to not have any finalization events. In that case, all deposits are outstanding.
        if (this.l2DepositFinalizedEvents[monitoredAddress][l1Token] === undefined) {
          this.l2DepositFinalizedEvents[monitoredAddress][l1Token] = [];
        }
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

        // Match deposits and finalizations by amount. We're only doing a limited lookback of events so collisions
        // should be unlikely.
        const finalizedAmounts = l2FinalizationSet.map((finalization) => finalization.amount.toString());
        const pendingDeposits = this.l1DepositInitiatedEvents[monitoredAddress][l1Token].filter((deposit) => {
          // Remove the first match. This handles scenarios where are collisions by amount.
          const index = finalizedAmounts.indexOf(deposit.amount.toString());
          if (index > -1) {
            finalizedAmounts.splice(index, 1);
            return false;
          }
          return true;
        });
        const totalAmount = pendingDeposits.reduce((acc, curr) => acc.add(curr.amount), toBN(0));
        const depositTxHashes = pendingDeposits.map((deposit) => deposit.txHash);
        outstandingTransfers[monitoredAddress][l1Token] = {
          totalAmount,
          depositTxHashes,
        };
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
