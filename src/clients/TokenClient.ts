import { utils as sdkUtils } from "@across-protocol/sdk";
import { HubPoolClient, SpokePoolClient } from ".";
import { CachingMechanismInterface, L1Token, Deposit } from "../interfaces";
import {
  BigNumber,
  bnZero,
  Contract,
  dedupArray,
  ERC20,
  isDefined,
  MAX_SAFE_ALLOWANCE,
  MAX_UINT_VAL,
  assign,
  blockExplorerLink,
  getNetworkName,
  Profiler,
  runTransaction,
  toBN,
  winston,
  getRedisCache,
  TOKEN_SYMBOLS_MAP,
} from "../utils";

export type TokenDataType = { [chainId: number]: { [token: string]: { balance: BigNumber; allowance: BigNumber } } };
type TokenShortfallType = {
  [chainId: number]: { [token: string]: { deposits: BigNumber[]; totalRequirement: BigNumber } };
};

export class TokenClient {
  private profiler: InstanceType<typeof Profiler>;
  tokenData: TokenDataType = {};
  tokenShortfall: TokenShortfallType = {};

  constructor(
    readonly logger: winston.Logger,
    readonly relayerAddress: string,
    readonly spokePoolClients: { [chainId: number]: SpokePoolClient },
    readonly hubPoolClient: HubPoolClient
  ) {
    this.profiler = new Profiler({ at: "TokenClient", logger });
  }

  getAllTokenData(): TokenDataType {
    return this.tokenData;
  }

  getBalance(chainId: number, token: string): BigNumber {
    if (!this._hasTokenPairData(chainId, token)) {
      return bnZero;
    }
    return this.tokenData[chainId][token].balance;
  }

  decrementLocalBalance(chainId: number, token: string, amount: BigNumber): void {
    this.tokenData[chainId][token].balance = this.tokenData[chainId][token].balance.sub(amount);
  }

  getShortfallTotalRequirement(chainId: number, token: string): BigNumber {
    return this.tokenShortfall?.[chainId]?.[token]?.totalRequirement ?? bnZero;
  }

  getTokensNeededToCoverShortfall(chainId: number, token: string): BigNumber {
    return this.getShortfallTotalRequirement(chainId, token).sub(this.getBalance(chainId, token));
  }

  getShortfallDeposits(chainId: number, token: string): BigNumber[] {
    return this.tokenShortfall?.[chainId]?.[token]?.deposits || [];
  }

  hasBalanceForFill(deposit: Deposit): boolean {
    return this.getBalance(deposit.destinationChainId, deposit.outputToken).gte(deposit.outputAmount);
  }

  // If the relayer tries to execute a relay but does not have enough tokens to fully fill it will capture the
  // shortfall by calling this method. This will track the information for logging purposes and use in other clients.
  captureTokenShortfall(chainId: number, token: string, depositId: BigNumber, unfilledAmount: BigNumber): void {
    // Shortfall is the previous shortfall + the current unfilledAmount from this deposit.
    const totalRequirement = this.getShortfallTotalRequirement(chainId, token).add(unfilledAmount);

    // Deposits are the previous shortfall deposits, appended to this depositId.
    const deposits = [...this.getShortfallDeposits(chainId, token), depositId];
    assign(this.tokenShortfall, [chainId, token], { deposits, totalRequirement });
  }

  captureTokenShortfallForFill(deposit: Deposit): void {
    const { outputAmount: unfilledAmount } = deposit;
    this.logger.debug({ at: "TokenBalanceClient", message: "Handling token shortfall", deposit, unfilledAmount });
    this.captureTokenShortfall(deposit.destinationChainId, deposit.outputToken, deposit.depositId, unfilledAmount);
  }

  // Returns the total token shortfall the client has seen. Shortfall is defined as the difference between the total
  // requirement to send all seen relays and the total remaining balance of the relayer.
  getTokenShortfall(): {
    [chainId: number]: {
      [token: string]: { balance: BigNumber; needed: BigNumber; shortfall: BigNumber; deposits: BigNumber[] };
    };
  } {
    const tokenShortfall: {
      [chainId: number]: {
        [token: string]: { balance: BigNumber; needed: BigNumber; shortfall: BigNumber; deposits: BigNumber[] };
      };
    } = {};
    Object.entries(this.tokenShortfall).forEach(([_chainId, tokenMap]) => {
      const chainId = Number(_chainId);
      Object.entries(tokenMap).forEach(([token, { totalRequirement, deposits }]) =>
        assign(tokenShortfall, [chainId, token], {
          balance: this.getBalance(chainId, token),
          needed: totalRequirement,
          shortfall: this.getTokensNeededToCoverShortfall(chainId, token),
          deposits,
        })
      );
    });
    return tokenShortfall;
  }

  anyCapturedShortFallFills(): boolean {
    return Object.keys(this.tokenShortfall).length != 0;
  }

  clearTokenShortfall(): void {
    this.tokenShortfall = {};
  }

  clearTokenData(): void {
    this.tokenData = {};
  }

  async setOriginTokenApprovals(): Promise<void> {
    const tokensToApprove: { chainId: number; token: string }[] = [];
    Object.entries(this.tokenData).forEach(([_chainId, tokenMap]) => {
      const chainId = Number(_chainId);
      Object.entries(tokenMap).forEach(([token, { balance, allowance }]) => {
        if (balance.gt(bnZero) && allowance.lt(MAX_SAFE_ALLOWANCE)) {
          tokensToApprove.push({ chainId, token });
        }
      });
    });
    if (tokensToApprove.length === 0) {
      this.logger.debug({ at: "TokenBalanceClient", message: "All token approvals set for non-zero balances" });
      return;
    }

    let mrkdwn = "*Approval transactions:* \n";
    for (const { token, chainId } of tokensToApprove) {
      const targetSpokePool = this.spokePoolClients[chainId].spokePool;
      const contract = new Contract(token, ERC20.abi, targetSpokePool.signer);
      const tx = await runTransaction(this.logger, contract, "approve", [targetSpokePool.address, MAX_UINT_VAL]);
      mrkdwn +=
        ` - Approved SpokePool ${blockExplorerLink(targetSpokePool.address, chainId)} ` +
        `to spend ${await contract.symbol()} ${blockExplorerLink(token, chainId)} on ${getNetworkName(chainId)}. ` +
        `tx: ${blockExplorerLink(tx.hash, chainId)}\n`;
    }
    this.logger.info({ at: "TokenBalanceClient", message: "Approved whitelisted tokens! 💰", mrkdwn });
  }

  async setBondTokenAllowance(): Promise<void> {
    const { hubPool } = this.hubPoolClient;
    const { signer } = hubPool;
    const [_bondToken, ownerAddress] = await Promise.all([this._getBondToken(), signer.getAddress()]);
    const bondToken = new Contract(_bondToken, ERC20.abi, signer);

    const currentCollateralAllowance: BigNumber = await bondToken.allowance(ownerAddress, hubPool.address);
    if (currentCollateralAllowance.lt(toBN(MAX_SAFE_ALLOWANCE))) {
      const tx = await runTransaction(this.logger, bondToken, "approve", [hubPool.address, MAX_UINT_VAL]);
      const { chainId } = this.hubPoolClient;
      const mrkdwn =
        ` - Approved HubPool ${blockExplorerLink(hubPool.address, chainId)} ` +
        `to spend ${await bondToken.symbol()} ${blockExplorerLink(bondToken.address, chainId)}. ` +
        `tx ${blockExplorerLink(tx.hash, chainId)}\n`;
      this.logger.info({ at: "hubPoolClient", message: "Approved bond tokens! 💰", mrkdwn });
    } else {
      this.logger.debug({ at: "hubPoolClient", message: "Bond token approval set" });
    }
  }

  resolveRemoteTokens(chainId: number, hubPoolTokens: L1Token[]): Contract[] {
    const { signer } = this.spokePoolClients[chainId].spokePool;

    if (chainId === this.hubPoolClient.chainId) {
      return hubPoolTokens.map(({ address }) => new Contract(address, ERC20.abi, signer));
    }

    const tokens = hubPoolTokens
      .map(({ symbol, address }) => {
        let tokenAddrs: string[] = [];
        try {
          const spokePoolToken = this.hubPoolClient.getL2TokenForL1TokenAtBlock(address, chainId);
          tokenAddrs.push(spokePoolToken);
        } catch {
          // No known deployment for this token on the SpokePool.
          // note: To be overhauled subject to https://github.com/across-protocol/sdk/pull/643
        }

        // If the HubPool token is USDC then it might map to multiple tokens on the destination chain.
        if (symbol === "USDC") {
          ["USDC.e", "USDbC"]
            .map((symbol) => TOKEN_SYMBOLS_MAP[symbol]?.addresses[chainId])
            .filter(isDefined)
            .forEach((address) => tokenAddrs.push(address));
          tokenAddrs = dedupArray(tokenAddrs);
        }

        return tokenAddrs.filter(isDefined).map((address) => new Contract(address, ERC20.abi, signer));
      })
      .flat();

    return tokens;
  }

  async updateChain(
    chainId: number,
    hubPoolTokens: L1Token[]
  ): Promise<Record<string, { balance: BigNumber; allowance: BigNumber }>> {
    const { spokePool } = this.spokePoolClients[chainId];

    const multicall3 = sdkUtils.getMulticall3(chainId, spokePool.provider);
    if (!isDefined(multicall3)) {
      return this.fetchTokenData(chainId, hubPoolTokens);
    }

    const { relayerAddress } = this;
    const balances: sdkUtils.Call3[] = [];
    const allowances: sdkUtils.Call3[] = [];
    this.resolveRemoteTokens(chainId, hubPoolTokens).forEach((token) => {
      balances.push({ contract: token, method: "balanceOf", args: [relayerAddress] });
      allowances.push({ contract: token, method: "allowance", args: [relayerAddress, spokePool.address] });
    });

    const calls = [...balances, ...allowances];
    const results = await sdkUtils.aggregate(multicall3, calls);

    const allowanceOffset = balances.length;
    const balanceInfo = Object.fromEntries(
      balances.map(({ contract: { address } }, idx) => {
        return [address, { balance: results[idx][0], allowance: results[allowanceOffset + idx][0] }];
      })
    );

    return balanceInfo;
  }

  async update(): Promise<void> {
    const mark = this.profiler.start("update");
    this.logger.debug({ at: "TokenBalanceClient", message: "Updating TokenBalance client" });
    const { hubPoolClient } = this;

    const hubPoolTokens = hubPoolClient.getL1Tokens();
    const chainIds = Object.values(this.spokePoolClients).map(({ chainId }) => chainId);

    const balanceInfo = await Promise.all(
      chainIds
        .filter((chainId) => isDefined(this.spokePoolClients[chainId]))
        .map((chainId) => this.updateChain(chainId, hubPoolTokens))
    );

    balanceInfo.forEach((tokenData, idx) => {
      const chainId = chainIds[idx];
      for (const token of Object.keys(tokenData)) {
        assign(this.tokenData, [chainId, token], tokenData[token]);
      }
    });

    // Remove allowance from token data when logging.
    const balanceData = Object.fromEntries(
      Object.entries(this.tokenData).map(([chainId, tokenData]) => {
        return [
          chainId,
          Object.fromEntries(
            Object.entries(tokenData).map(([token, { balance }]) => {
              return [token, balance];
            })
          ),
        ];
      })
    );

    mark.stop({ message: "Updated TokenBalance client.", balanceData });
  }

  async fetchTokenData(
    chainId: number,
    hubPoolTokens: L1Token[]
  ): Promise<Record<string, { balance: BigNumber; allowance: BigNumber }>> {
    const spokePoolClient = this.spokePoolClients[chainId];

    const { relayerAddress } = this;
    const tokenData = Object.fromEntries(
      await sdkUtils.mapAsync(this.resolveRemoteTokens(chainId, hubPoolTokens), async (token: Contract) => {
        const balance: BigNumber = await token.balanceOf(relayerAddress);
        const allowance = await this._getAllowance(spokePoolClient, token);
        return [token.address, { balance, allowance }];
      })
    );

    return tokenData;
  }

  private _getAllowanceCacheKey(spokePoolClient: SpokePoolClient, originToken: string): string {
    const { chainId, spokePool } = spokePoolClient;
    return `l2TokenAllowance_${chainId}_${originToken}_${this.relayerAddress}_targetContract:${spokePool.address}`;
  }

  private async _getAllowance(spokePoolClient: SpokePoolClient, token: Contract): Promise<BigNumber> {
    const key = this._getAllowanceCacheKey(spokePoolClient, token.address);
    const redis = await this.getRedis();
    if (redis) {
      const result = await redis.get<string>(key);
      if (result !== null) {
        return toBN(result);
      }
    }
    const allowance: BigNumber = await token.allowance(this.relayerAddress, spokePoolClient.spokePool.address);
    if (allowance.gte(MAX_SAFE_ALLOWANCE) && redis) {
      // Save allowance in cache with no TTL as these should be exhausted.
      await redis.set(key, MAX_SAFE_ALLOWANCE);
    }
    return allowance;
  }

  _getBondTokenCacheKey(): string {
    return `bondToken_${this.hubPoolClient.hubPool.address}`;
  }

  private async _getBondToken(): Promise<string> {
    const redis = await this.getRedis();
    if (redis) {
      const cachedBondToken = await redis.get<string>(this._getBondTokenCacheKey());
      if (cachedBondToken !== null) {
        return cachedBondToken;
      }
    }
    const bondToken: string = await this.hubPoolClient.hubPool.bondToken();
    if (redis) {
      // The bond token should not change, and using the wrong bond token will be immediately obvious, so cache with
      // infinite TTL.
      await redis.set(this._getBondTokenCacheKey(), bondToken);
    }
    return bondToken;
  }

  private _hasTokenPairData(chainId: number, token: string) {
    const hasData = !!this.tokenData?.[chainId]?.[token];
    if (!hasData) {
      this.logger.warn({ at: "TokenBalanceClient", message: `No data on ${getNetworkName(chainId)} -> ${token}` });
    }
    return hasData;
  }

  protected async getRedis(): Promise<CachingMechanismInterface | undefined> {
    return getRedisCache(this.logger);
  }
}
