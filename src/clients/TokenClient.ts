import { BigNumber, winston, assign, ERC20, Contract, toBN, MAX_SAFE_ALLOWANCE } from "../utils";
import { runTransaction, getNetworkName, etherscanLink, MAX_UINT_VAL } from "../utils";
import { HubPoolClient, SpokePoolClient } from ".";
import { Deposit } from "../interfaces";

export class TokenClient {
  tokenData: { [chainId: number]: { [token: string]: { balance: BigNumber; allowance: BigNumber } } } = {};
  tokenShortfall: {
    [chainId: number]: { [token: string]: { deposits: number[]; totalRequirement: BigNumber } };
  } = {};
  bondToken: Contract;

  constructor(
    readonly logger: winston.Logger,
    readonly relayerAddress,
    readonly spokePoolClients: { [chainId: number]: SpokePoolClient },
    readonly hubPoolClient: HubPoolClient
  ) {}

  getAllTokenData() {
    return this.tokenData;
  }

  getDataForToken(chainId: number, token: string) {
    if (!this._hasTokenPairData(chainId, token)) return {};
    return this.tokenData[chainId][token];
  }

  getBalance(chainId: number | string, token: string) {
    if (!this._hasTokenPairData(chainId, token)) return toBN(0);
    return this.tokenData[chainId][token].balance;
  }

  getAllowanceOnChain(chainId: number, token: string) {
    if (!this._hasTokenPairData(chainId, token)) return toBN(0);
    return this.tokenData[chainId][token].allowance;
  }

  decrementLocalBalance(chainId: number, token: string, amount: BigNumber) {
    this.tokenData[chainId][token].balance = this.tokenData[chainId][token].balance.sub(amount);
  }

  getShortfallTotalRequirement(chainId: number | string, token: string) {
    return this.tokenShortfall?.[chainId]?.[token]?.totalRequirement || toBN(0);
  }

  getTokensNeededToCoverShortfall(chainId: number | string, token: string) {
    return this.getShortfallTotalRequirement(chainId, token).sub(this.getBalance(chainId, token));
  }

  getShortfallDeposits(chainId: number | string, token: string) {
    return this.tokenShortfall?.[chainId]?.[token]?.deposits || [];
  }

  hasBalanceForFill(deposit: Deposit, fillAmount: BigNumber) {
    return this.getBalance(deposit.destinationChainId, deposit.destinationToken).gte(fillAmount);
  }

  hasBalanceForZeroFill(deposit: Deposit) {
    return this.getBalance(deposit.destinationChainId, deposit.destinationToken).gte(toBN(1));
  }

  // If the relayer tries to execute a relay but does not have enough tokens to fully fill it it will capture the
  // shortfall by calling this method. This will track the information for logging purposes and use in other clients.
  captureTokenShortfall(chainId: number, token: string, depositId: number, unfilledAmount: BigNumber) {
    // Shortfall is the previous shortfall + the current unfilledAmount from this deposit.
    const totalRequirement = this.getShortfallTotalRequirement(chainId, token).add(unfilledAmount);

    // Deposits are the previous shortfall deposits, appended to this depositId.
    const deposits = [...this.getShortfallDeposits(chainId, token), depositId];
    assign(this.tokenShortfall, [chainId, token], { deposits, totalRequirement });
  }

  captureTokenShortfallForFill(deposit: Deposit, unfilledAmount: BigNumber) {
    this.logger.debug({ at: "TokenBalanceClient", message: "Handling token shortfall", deposit, unfilledAmount });
    this.captureTokenShortfall(deposit.destinationChainId, deposit.destinationToken, deposit.depositId, unfilledAmount);
  }

  // Returns the total token shortfall the client has seen. Shortfall is defined as the difference between the total
  // requirement to send all seen relays and the total remaining balance of the relayer.
  getTokenShortfall() {
    const tokenShortfall = {};
    Object.keys(this.tokenShortfall).forEach((chainId) =>
      Object.keys(this.tokenShortfall[chainId]).forEach((token) =>
        assign(tokenShortfall, [chainId, token], {
          balance: this.getBalance(chainId, token),
          needed: this.getShortfallTotalRequirement(chainId, token),
          shortfall: this.getTokensNeededToCoverShortfall(chainId, token),
          deposits: this.getShortfallDeposits(chainId, token),
        })
      )
    );
    return tokenShortfall;
  }

  anyCapturedShortFallFills(): boolean {
    return Object.keys(this.tokenShortfall).length != 0;
  }

  clearTokenShortfall() {
    this.tokenShortfall = {};
  }

  async setOriginTokenApprovals() {
    const tokensToApprove: { chainId: string; token: string }[] = [];
    Object.keys(this.tokenData).forEach((chainId) => {
      Object.keys(this.tokenData[chainId]).forEach((token) => {
        if (
          this.tokenData[chainId][token].balance.gt(toBN(0)) &&
          this.tokenData[chainId][token].allowance.lt(toBN(MAX_SAFE_ALLOWANCE))
        )
          tokensToApprove.push({ chainId, token });
      });
    });
    if (tokensToApprove.length === 0) {
      this.logger.debug({ at: "TokenBalanceClient", message: `All token approvals set for non-zero balances` });
      return;
    }

    let mrkdwn = "*Approval transactions:* \n";
    for (const { token, chainId } of tokensToApprove) {
      const targetSpokePool = this.spokePoolClients[chainId].spokePool;
      const contract = new Contract(token, ERC20.abi, targetSpokePool.signer);
      const tx = await runTransaction(this.logger, contract, "approve", [targetSpokePool.address, MAX_UINT_VAL]);
      const receipt = await tx.wait();
      mrkdwn +=
        ` - Approved SpokePool ${etherscanLink(targetSpokePool.address, chainId)} ` +
        `to spend ${await contract.symbol()} ${etherscanLink(token, chainId)} on ${getNetworkName(chainId)}. ` +
        `tx: ${etherscanLink(receipt.transactionHash, chainId)}\n`;
    }
    this.logger.info({ at: "TokenBalanceClient", message: `Approved whitelisted tokens! 💰`, mrkdwn });
  }

  async setBondTokenAllowance() {
    const ownerAddress = await this.hubPoolClient.hubPool.signer.getAddress();
    const currentCollateralAllowance: BigNumber = await this.bondToken.allowance(
      ownerAddress,
      this.hubPoolClient.hubPool.address
    );
    if (currentCollateralAllowance.lt(toBN(MAX_SAFE_ALLOWANCE))) {
      const tx = await runTransaction(this.logger, this.bondToken, "approve", [
        this.hubPoolClient.hubPool.address,
        MAX_UINT_VAL,
      ]);
      const receipt = await tx.wait();
      const mrkdwn =
        ` - Approved HubPool ${etherscanLink(this.hubPoolClient.hubPool.address, 1)} ` +
        `to spend ${await this.bondToken.symbol()} ${etherscanLink(this.bondToken.address, 1)}. ` +
        `tx ${etherscanLink(receipt.transactionHash, 1)}\n`;
      this.logger.info({ at: "hubPoolClient", message: `Approved bond tokens! 💰`, mrkdwn });
    } else this.logger.debug({ at: "hubPoolClient", message: `Bond token approval set` });
  }

  async update() {
    this.logger.debug({ at: "TokenBalanceClient", message: "Updating TokenBalance client" });

    const [balanceInfo, bondToken] = await Promise.all([
      Promise.all(Object.values(this.spokePoolClients).map((spokePoolClient) => this.fetchTokenData(spokePoolClient))),
      this.hubPoolClient.hubPool.bondToken(),
    ]);

    this.bondToken = new Contract(bondToken, ERC20.abi, this.hubPoolClient.hubPool.signer);

    for (const { chainId, tokenData } of balanceInfo)
      for (const token of Object.keys(tokenData)) assign(this.tokenData, [chainId, token], tokenData[token]);

    this.logger.debug({ at: "TokenBalanceClient", message: "TokenBalance client updated!" });
  }

  async fetchTokenData(spokePoolClient: SpokePoolClient) {
    const tokens = spokePoolClient
      .getAllOriginTokens()
      .map((address) => new Contract(address, ERC20.abi, spokePoolClient.spokePool.signer));

    const [balances, allowances] = await Promise.all([
      Promise.all(tokens.map((token) => token.balanceOf(this.relayerAddress))),
      Promise.all(tokens.map((token) => token.allowance(this.relayerAddress, spokePoolClient.spokePool.address))),
    ]);

    const tokenData = {};
    for (const [index, token] of tokens.entries())
      tokenData[token.address] = { balance: balances[index], allowance: allowances[index] };

    return { tokenData, chainId: spokePoolClient.chainId };
  }

  private _hasTokenPairData(chainId: number | string, token: string) {
    let hasData = true;
    if (this.tokenData === {}) hasData = false;
    else if (!this.tokenData[chainId]) hasData = false;
    else if (!this.tokenData[chainId][token]) hasData = false;
    if (!hasData)
      this.logger.warn({ at: "TokenBalanceClient", message: `No data on ${getNetworkName(chainId)} -> ${token}` });
    return hasData;
  }
}
