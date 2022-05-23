import { SpokePoolClient } from "../../clients";
import { toBN, MAX_SAFE_ALLOWANCE, Contract, ERC20 } from "../../utils";
import { etherscanLink, getNetworkName, MAX_UINT_VAL, runTransaction } from "../../utils";
export class BaseAdapter {
  chainId: number;
  l1SearchConfig;
  l2SearchConfig;
  relayerAddress;
  logger;

  l1DepositInitiatedEvents: { [l1Token: string]: any[] } = {};
  l2DepositFinalizedEvents: { [l1Token: string]: any[] } = {};
  constructor(readonly spokePoolClients: { [chainId: number]: SpokePoolClient }) {}

  getSigner(chainId: number) {
    return this.spokePoolClients[chainId].spokePool.signer;
  }

  getProvider(chainId: number) {
    return this.spokePoolClients[chainId].spokePool.provider;
  }

  getSearchConfig(chainId: number) {
    return this.spokePoolClients[chainId].eventSearchConfig;
  }

  async updateFromBlockSearchConfig() {
    const [l1BlockNumber, l2BlockNumber] = await Promise.all([
      this.getProvider(1).getBlockNumber(),
      this.getProvider(this.chainId).getBlockNumber(),
    ]);

    this.l1SearchConfig.toBlock = l1BlockNumber;
    this.l2SearchConfig.toBlock = l2BlockNumber;
  }

  async checkAndSendTokenApprovals(l1Tokens: string[], associatedL1Bridges: string[]) {
    this.log("Checking and sending token approvals", { l1Tokens, associatedL1Bridges });
    const tokensToApprove: { l1Token: any; targetContract: string }[] = [];
    const l1TokenContracts = l1Tokens.map((l1Token) => new Contract(l1Token, ERC20.abi, this.getSigner(1)));
    const allowances = await Promise.all(
      l1TokenContracts.map((l1TokenContract, index) =>
        l1TokenContract.allowance(this.relayerAddress, associatedL1Bridges[index])
      )
    );

    allowances.forEach((allowance, index) => {
      if (allowance.lt(toBN(MAX_SAFE_ALLOWANCE)))
        tokensToApprove.push({ l1Token: l1TokenContracts[index], targetContract: associatedL1Bridges[index] });
    });

    if (tokensToApprove.length == 0) {
      this.log("No Approvals needed", l1Tokens);
      return;
    }

    let mrkdwn = "*Approval transactions:* \n";
    for (const { l1Token, targetContract } of tokensToApprove) {
      const tx = await runTransaction(this.logger, l1Token, "approve", [targetContract, MAX_UINT_VAL]);
      const receipt = await tx.wait();
      mrkdwn +=
        ` - Approved Canonical token bridge ${etherscanLink(targetContract, 1)} ` +
        `to spend ${await l1Token.symbol()} ${etherscanLink(l1Token.address, 1)} on ${getNetworkName(1)}. ` +
        `tx: ${etherscanLink(receipt.transactionHash, 1)}\n`;
    }
    this.log("Approved whitelisted tokens! 💰", { mrkdwn }, "info");
  }

  log(message: string, data?: any, level: string = "debug") {
    this.logger[level]({ at: `${getNetworkName(this.chainId)}Adapter`, message, ...data });
  }
}
