import { Signer } from "ethers";
import { HubPoolClient, SpokePoolClient } from ".";
import { CachingMechanismInterface, V3Deposit } from "../interfaces";
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
  runTransaction,
  toBN,
  winston,
  getMultisender,
  getRedisCache,
  TOKEN_SYMBOLS_MAP,
} from "../utils";

type TokenDataType = { [chainId: number]: { [token: string]: { balance: BigNumber; allowance: BigNumber } } };
type TokenShortfallType = {
  [chainId: number]: { [token: string]: { deposits: number[]; totalRequirement: BigNumber } };
};

export class TokenClient {
  tokenData: TokenDataType = {};
  tokenShortfall: TokenShortfallType = {};
  bondToken: Contract | undefined;

  constructor(
    readonly logger: winston.Logger,
    readonly relayerAddress: string,
    readonly spokePoolClients: { [chainId: number]: SpokePoolClient },
    readonly hubPoolClient: HubPoolClient
  ) {}

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

  getShortfallDeposits(chainId: number, token: string): number[] {
    return this.tokenShortfall?.[chainId]?.[token]?.deposits || [];
  }

  hasBalanceForFill(deposit: V3Deposit): boolean {
    return this.getBalance(deposit.destinationChainId, deposit.outputToken).gte(deposit.outputAmount);
  }

  // If the relayer tries to execute a relay but does not have enough tokens to fully fill it it will capture the
  // shortfall by calling this method. This will track the information for logging purposes and use in other clients.
  captureTokenShortfall(chainId: number, token: string, depositId: number, unfilledAmount: BigNumber): void {
    // Shortfall is the previous shortfall + the current unfilledAmount from this deposit.
    const totalRequirement = this.getShortfallTotalRequirement(chainId, token).add(unfilledAmount);

    // Deposits are the previous shortfall deposits, appended to this depositId.
    const deposits = [...this.getShortfallDeposits(chainId, token), depositId];
    assign(this.tokenShortfall, [chainId, token], { deposits, totalRequirement });
  }

  captureTokenShortfallForFill(deposit: V3Deposit): void {
    const { outputAmount: unfilledAmount } = deposit;
    this.logger.debug({ at: "TokenBalanceClient", message: "Handling token shortfall", deposit, unfilledAmount });
    this.captureTokenShortfall(deposit.destinationChainId, deposit.outputToken, deposit.depositId, unfilledAmount);
  }

  // Returns the total token shortfall the client has seen. Shortfall is defined as the difference between the total
  // requirement to send all seen relays and the total remaining balance of the relayer.
  getTokenShortfall(): {
    [chainId: number]: {
      [token: string]: { balance: BigNumber; needed: BigNumber; shortfall: BigNumber; deposits: number[] };
    };
  } {
    const tokenShortfall: {
      [chainId: number]: {
        [token: string]: { balance: BigNumber; needed: BigNumber; shortfall: BigNumber; deposits: number[] };
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
    if (!this.bondToken) {
      throw new Error("TokenClient::setBondTokenAllowance bond token not initialized");
    }
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
      const mrkdwn =
        ` - Approved HubPool ${blockExplorerLink(this.hubPoolClient.hubPool.address, 1)} ` +
        `to spend ${await this.bondToken.symbol()} ${blockExplorerLink(this.bondToken.address, 1)}. ` +
        `tx ${blockExplorerLink(tx.hash, 1)}\n`;
      this.logger.info({ at: "hubPoolClient", message: "Approved bond tokens! 💰", mrkdwn });
    } else {
      this.logger.debug({ at: "hubPoolClient", message: "Bond token approval set" });
    }
  }

  async update(): Promise<void> {
    this.logger.debug({ at: "TokenBalanceClient", message: "Updating TokenBalance client" });
    const { hubPoolClient } = this;

    const hubPoolTokens = hubPoolClient.getL1Tokens().map(({ address }) => address);
    const chainIds = Object.values(this.spokePoolClients).map(({ chainId }) => chainId);
    const balanceQueries = chainIds.map((chainId) =>
      this.fetchTokenData(chainId, hubPoolTokens, this.spokePoolClients[chainId].spokePool.signer)
    );

    const [bondToken, ...balanceInfo] = await Promise.all([this._getBondToken(), ...balanceQueries]);
    this.bondToken = new Contract(bondToken, ERC20.abi, this.hubPoolClient.hubPool.signer);

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
    this.logger.debug({ at: "TokenBalanceClient", message: "TokenBalance client updated!", balanceData });
  }

  async fetchTokenData(
    chainId: number,
    hubPoolTokens: string[],
    signer: Signer
  ): Promise<Record<string, { balance: BigNumber; allowance: BigNumber }>> {
    const { hubPoolClient } = this;
    const tokens = hubPoolTokens
      .map((address) => {
        let tokenAddrs: string[] = [];
        try {
          const spokePoolToken = hubPoolClient.getL2TokenForL1TokenAtBlock(address, chainId);
          tokenAddrs.push(spokePoolToken);
        } catch {
          // No known deployment for this token on the SpokePool.
        }

        // If the HubPool token is USDC then it might map to multiple tokens on the destination chain.
        const { symbol } = hubPoolClient.getL1Tokens().find((hubPoolToken) => hubPoolToken.address === address);
        if (symbol === "USDC") {
          // At the moment, constants-v3 defines native usdc as _USDC.
          const usdcAliases = ["_USDC", "USDC.e", "USDbC"]; // After constants-v3 update: ["USDC.e", "USDbC"]
          usdcAliases
            .map((symbol) => TOKEN_SYMBOLS_MAP[symbol]?.addresses[chainId])
            .filter(isDefined)
            .forEach((address) => tokenAddrs.push(address));
          tokenAddrs = dedupArray(tokenAddrs);
        }
        return tokenAddrs.filter(isDefined).map((address) => new Contract(address, ERC20.abi, signer));
      })
      .flat();

    const multicall3 = async (multicall: Contract) => {
      const { spokePool } = this.spokePoolClients[chainId];
      const { relayerAddress } = this;
      const _balanceOf = "balanceOf";
      const _allowance = "allowance";

      const balances: { target: string; callData: string }[] = [];
      const allowances: { target: string; callData: string }[] = [];
      tokens.forEach((token) => {
        const {
          address: target,
          interface: { encodeFunctionData },
        } = token;
        balances.push({ target, callData: encodeFunctionData(_balanceOf, [relayerAddress]) });
        allowances.push({ target, callData: encodeFunctionData(_allowance, [relayerAddress, spokePool.address]) });
      });

      const [, results] = await multicall.callStatic.aggregate([...balances, ...allowances]);
      const allowanceOffset = tokens.length;
      const tokenData = Object.fromEntries(
        tokens.map((token, idx) => {
          const { address } = token;
          const balance = token.interface.decodeFunctionResult(_balanceOf, results[idx])[0];
          const allowance = token.interface.decodeFunctionResult(_allowance, results[allowanceOffset + idx])[0];
          return [address, { balance, allowance }];
        })
      );

      return tokenData;
    };

    const multicall = await getMultisender(chainId, signer);
    const tokenData = isDefined(multicall)
      ? multicall3(multicall)
      : Object.fromEntries(
          await Promise.all(
            tokens.map(async (token) => {
              const balance: BigNumber = await token.balanceOf(this.relayerAddress);
              const allowance = await this._getAllowance(this.spokePoolClients[chainId], token);
              return [token.address, { balance, allowance }];
            })
          )
        );

    return tokenData;
  }

  private _getAllowance(spokePoolClient: SpokePoolClient, token: Contract): Promise<BigNumber> {
    return token.allowance(this.relayerAddress, spokePoolClient.spokePool.address);
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
