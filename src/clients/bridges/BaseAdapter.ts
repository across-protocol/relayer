/* eslint-disable @typescript-eslint/ban-types */
import { Provider } from "@ethersproject/abstract-provider";
import { Signer } from "@ethersproject/abstract-signer";
import { utils } from "@across-protocol/sdk";
import { AugmentedTransaction, SpokePoolClient, TransactionClient } from "../../clients";
import { CONTRACT_ADDRESSES } from "../../common";
import { OutstandingTransfers, SortableEvent } from "../../interfaces";
import {
  AnyObject,
  BigNumber,
  bnZero,
  Contract,
  DefaultLogLevels,
  ERC20,
  EventSearchConfig,
  isDefined,
  MAX_SAFE_ALLOWANCE,
  MakeOptional,
  TransactionResponse,
  ZERO_ADDRESS,
  assert,
  compareAddressesSimple,
  formatUnitsForToken,
  getNetworkName,
  matchTokenSymbol,
  toBN,
  winston,
  createFormatFunction,
  BigNumberish,
  TOKEN_SYMBOLS_MAP,
  getTokenAddressWithCCTP,
} from "../../utils";
import { approveTokens, getAllowanceCacheKey, getTokenAllowanceFromCache, setTokenAllowanceInCache } from "./utils";

import { BaseChainAdapter } from "../../adapter";

export interface DepositEvent extends SortableEvent {
  amount: BigNumber;
  transactionHash: string;
}

interface Events {
  [address: string]: {
    [l1Token: string]: { [l2Token: string]: DepositEvent[] };
  };
}

// TODO: make these generic arguments to BaseAdapter.
type SupportedL1Token = string;
type SupportedTokenSymbol = string;

export class BaseAdapter extends BaseChainAdapter {
  static readonly HUB_CHAIN_ID = 1; // @todo: Make dynamic

  readonly hubChainId = BaseAdapter.HUB_CHAIN_ID;

  readonly wethAddress = TOKEN_SYMBOLS_MAP.WETH.addresses[this.hubChainId];
  readonly atomicDepositorAddress = CONTRACT_ADDRESSES[this.hubChainId]?.atomicDepositor.address;

  l1DepositInitiatedEvents: Events = {};
  l2DepositFinalizedEvents: Events = {};

  txnClient: TransactionClient;

  constructor(
    readonly spokePoolClients: { [chainId: number]: SpokePoolClient },
    readonly chainId: number,
    readonly monitoredAddresses: string[],
    readonly logger: winston.Logger,
    readonly supportedTokens: SupportedTokenSymbol[]
  ) {
    // If the BaseAdapter constructor is being called, we know the caller is a constructor of one of the tailored
    // chain adapters, so we do not need to supply any bridges/gas multiplier, since the bridging logic is done
    // in the adapters themselves.
    super(spokePoolClients, chainId, BaseAdapter.HUB_CHAIN_ID, monitoredAddresses, logger, supportedTokens, {}, 1);
    this.txnClient = new TransactionClient(logger);
  }

  getSigner(chainId: number): Signer {
    return this.spokePoolClients[chainId].spokePool.signer;
  }

  getProvider(chainId: number): Provider {
    return this.spokePoolClients[chainId].spokePool.provider;
  }

  filterSupportedTokens(l1Tokens: string[]): string[] {
    return l1Tokens.filter((l1Token) => this.isSupportedToken(l1Token));
  }

  // Note: this must be called after the SpokePoolClients are updated.
  getUpdatedSearchConfigs(): { l1SearchConfig: EventSearchConfig; l2SearchConfig: EventSearchConfig } {
    const l1LatestBlock = this.spokePoolClients[this.hubChainId].latestBlockSearched;
    const l2LatestBlock = this.spokePoolClients[this.chainId].latestBlockSearched;
    if (l1LatestBlock === 0 || l2LatestBlock === 0) {
      throw new Error("One or more SpokePoolClients have not been updated");
    }

    return {
      l1SearchConfig: {
        ...this.baseL1SearchConfig,
        toBlock: this.baseL1SearchConfig?.toBlock ?? l1LatestBlock,
      },
      l2SearchConfig: {
        ...this.baseL2SearchConfig,
        toBlock: this.baseL2SearchConfig?.toBlock ?? l2LatestBlock,
      },
    };
  }

  getSearchConfig(chainId: number): MakeOptional<EventSearchConfig, "toBlock"> {
    return { ...this.spokePoolClients[chainId].eventSearchConfig };
  }

  async getAllowanceCacheKey(l1Token: string, targetContract: string): Promise<string> {
    return getAllowanceCacheKey(l1Token, targetContract, await this.getSigner(this.hubChainId).getAddress());
  }

  resolveL2TokenAddress(l1Token: string, isNativeUsdc = false): string {
    return getTokenAddressWithCCTP(l1Token, this.hubChainId, this.chainId, isNativeUsdc);
  }

  async checkAndSendTokenApprovals(address: string, l1Tokens: string[], l1Bridges: string[]): Promise<void> {
    this.log("Checking and sending token approvals", { l1Tokens, l1Bridges });
    assert(l1Tokens.length === l1Bridges.length, "Token and bridge arrays are not the same length");

    const l1TokenContracts = l1Tokens.map(
      (l1Token) => new Contract(l1Token, ERC20.abi, this.getSigner(this.hubChainId))
    );

    const allowances = await Promise.all(
      l1TokenContracts.map(async (l1Token, idx) => {
        const l1Bridge = l1Bridges[idx];

        // If there is not both a l1TokenContract and l1Bridge then return a number that wont send an approval
        // transaction. For example not every chain has a bridge contract for every token. In this case we clearly
        // don't want to send any approval transactions.
        if (!l1Token && l1Bridge) {
          return undefined;
        }

        // Check if we've cached already that this allowance is high enough, else fallback to an RPC query.
        let allowance = await getTokenAllowanceFromCache(l1Token.address, address, l1Bridge);
        if (!allowance) {
          // If the onchain allowance is > MAX_SAFE_ALLOWANCE, cache it for next time.
          allowance = await l1Token.allowance(address, l1Bridge);
          if (allowance.gte(MAX_SAFE_ALLOWANCE)) {
            await setTokenAllowanceInCache(l1Token.address, address, l1Bridge, allowance);
          }
        }

        return allowance;
      })
    );

    const tokensToApprove = allowances
      .map((allowance, idx) => {
        const token = l1TokenContracts[idx];
        const bridge = l1Bridges[idx];
        if (token && bridge && allowance.lt(MAX_SAFE_ALLOWANCE)) {
          return { token, bridge };
        }
      })
      .filter(isDefined);
    if (tokensToApprove.length === 0) {
      this.log("No token bridge approvals needed", { l1Tokens });
      return;
    }

    const mrkdwn = await approveTokens(tokensToApprove, this.chainId, this.hubChainId, this.logger);
    this.log("Approved whitelisted tokens! 💰", { mrkdwn }, "info");
  }

  computeOutstandingCrossChainTransfers(l1Tokens: string[]): OutstandingTransfers {
    const outstandingTransfers: OutstandingTransfers = {};

    for (const monitoredAddress of this.monitoredAddresses) {
      // Skip if there are no deposit events for this address at all.
      if (this.l1DepositInitiatedEvents[monitoredAddress] === undefined) {
        continue;
      }

      outstandingTransfers[monitoredAddress] ??= {};

      this.l2DepositFinalizedEvents[monitoredAddress] ??= {};

      for (const l1Token of l1Tokens) {
        // Skip if there has been no deposits for this token.
        if (this.l1DepositInitiatedEvents[monitoredAddress][l1Token] === undefined) {
          continue;
        }

        // It's okay to not have any finalization events. In that case, all deposits are outstanding.
        this.l2DepositFinalizedEvents[monitoredAddress][l1Token] ??= {};

        // We want to iterate over the deposit events that have been initiated. We'll then match them with the
        // finalization events to determine which deposits are still outstanding.
        for (const l2Token of Object.keys(this.l1DepositInitiatedEvents[monitoredAddress][l1Token])) {
          this.l2DepositFinalizedEvents[monitoredAddress][l1Token][l2Token] ??= [];
          const l2FinalizationSet = this.l2DepositFinalizedEvents[monitoredAddress][l1Token][l2Token];

          // Match deposits and finalizations by amount. We're only doing a limited lookback of events so collisions
          // should be unlikely.
          const finalizedAmounts = l2FinalizationSet.map((finalization) => finalization.amount.toString());
          const pendingDeposits = this.l1DepositInitiatedEvents[monitoredAddress][l1Token][l2Token].filter(
            (deposit) => {
              // Remove the first match. This handles scenarios where are collisions by amount.
              const index = finalizedAmounts.indexOf(deposit.amount.toString());
              if (index > -1) {
                finalizedAmounts.splice(index, 1);
                return false;
              }
              return true;
            }
          );

          // Short circuit early if there are no pending deposits.
          if (pendingDeposits.length === 0) {
            continue;
          }

          outstandingTransfers[monitoredAddress][l1Token] ??= {};

          const totalAmount = pendingDeposits.reduce((acc, curr) => acc.add(curr.amount), bnZero);
          const depositTxHashes = pendingDeposits.map((deposit) => deposit.transactionHash);
          outstandingTransfers[monitoredAddress][l1Token][l2Token] = {
            totalAmount,
            depositTxHashes,
          };
        }
      }
    }

    return outstandingTransfers;
  }

  log(message: string, data?: AnyObject, level: DefaultLogLevels = "debug"): void {
    this.logger[level]({ at: this.getName(), message, ...data });
  }

  getName(): string {
    return `${getNetworkName(this.chainId)}Adapter`;
  }

  /**
   * Return true if passed in token address is L1 WETH address
   * @param l1Token an address
   * @returns True if l1Token is L1 weth address
   */
  isWeth(l1Token: string): boolean {
    return compareAddressesSimple(l1Token, this.wethAddress);
  }

  isHubChainContract(address: string): Promise<Boolean> {
    return utils.isContractDeployedToAddress(address, this.getProvider(this.hubChainId));
  }

  isL2ChainContract(address: string): Promise<Boolean> {
    return utils.isContractDeployedToAddress(address, this.getProvider(this.chainId));
  }

  /**
   * Get L1 Atomic WETH depositor contract
   * @returns L1 Atomic WETH depositor contract
   */
  getAtomicDepositor(): Contract {
    const { hubChainId } = this;
    return new Contract(
      this.atomicDepositorAddress,
      CONTRACT_ADDRESSES[hubChainId].atomicDepositor.abi,
      this.getSigner(hubChainId)
    );
  }

  getHubPool(): Contract {
    const hubPoolContractData = CONTRACT_ADDRESSES[this.hubChainId]?.hubPool;
    if (!hubPoolContractData) {
      throw new Error(`hubPoolContractData not found for chain ${this.hubChainId}`);
    }
    return new Contract(hubPoolContractData.address, hubPoolContractData.abi, this.getSigner(this.hubChainId));
  }

  /**
   * Determine whether this adapter supports an l1 token address
   * @param l1Token an address
   * @returns True if l1Token is supported
   */
  isSupportedToken(l1Token: string): l1Token is SupportedL1Token {
    const relevantSymbols = matchTokenSymbol(l1Token, this.hubChainId);
    // if the symbol is not in the supported tokens list, it's not supported
    return relevantSymbols.some((symbol) => this.supportedTokens.includes(symbol));
  }

  async _sendTokenToTargetChain(
    l1Token: string,
    l2Token: string,
    amount: BigNumberish,
    contract: Contract,
    method: string,
    args: unknown[],
    gasLimitMultiplier: number,
    msgValue: BigNumber,
    simMode: boolean
  ): Promise<TransactionResponse> {
    assert(this.isSupportedToken(l1Token), `Token ${l1Token} is not supported`);
    const tokenSymbol = matchTokenSymbol(l1Token, this.hubChainId)[0];
    const [srcChain, dstChain] = [getNetworkName(this.hubChainId), getNetworkName(this.chainId)];
    const message = `💌⭐️ Bridging tokens from ${srcChain} to ${dstChain}.`;
    const _txnRequest: AugmentedTransaction = {
      contract,
      chainId: this.hubChainId,
      method,
      args,
      gasLimitMultiplier,
      value: msgValue,
      message,
      mrkdwn: `Sent ${formatUnitsForToken(tokenSymbol, amount)} ${tokenSymbol} to chain ${dstChain}.`,
    };
    const { reason, succeed, transaction: txnRequest } = (await this.txnClient.simulate([_txnRequest]))[0];
    const { contract: targetContract, ...txnRequestData } = txnRequest;
    if (!succeed) {
      const message = `Failed to simulate ${method} deposit from ${txnRequest.chainId} for mainnet token ${l1Token}`;
      this.logger.warn({ at: this.getName(), message, reason, contract: targetContract.address, txnRequestData });
      throw new Error(`${message} (${reason})`);
    }

    this.logger.debug({
      at: `${this.getName()}#_sendTokenToTargetChain`,
      message,
      l1Token,
      l2Token,
      amount,
      contract: contract.address,
      txnRequestData,
    });
    if (simMode) {
      this.logger.debug({
        at: `${this.getName()}#_sendTokenToTargetChain`,
        message: "Simulation result",
        succeed,
      });
      return { hash: ZERO_ADDRESS } as TransactionResponse;
    }
    return (await this.txnClient.submit(this.hubChainId, [{ ...txnRequest }]))[0];
  }

  async _wrapEthIfAboveThreshold(
    wrapThreshold: BigNumber,
    l2WEthContract: Contract,
    value: BigNumber,
    simMode = false
  ): Promise<TransactionResponse> {
    const { chainId, txnClient } = this;
    const method = "deposit";
    const formatFunc = createFormatFunction(2, 4, false, 18);
    const mrkdwn =
      `${formatFunc(
        toBN(value).toString()
      )} Ether on chain ${chainId} was wrapped due to being over the threshold of ` +
      `${formatFunc(toBN(wrapThreshold).toString())} ETH.`;
    const message = `${formatFunc(toBN(value).toString())} Eth wrapped on target chain ${chainId}🎁`;
    if (simMode) {
      const { succeed, reason } = (
        await txnClient.simulate([{ contract: l2WEthContract, chainId, method, args: [], value, mrkdwn, message }])
      )[0];
      this.logger.debug({
        at: `${this.getName()}#_wrapEthIfAboveThreshold`,
        message: "Simulation result",
        l2WEthContract: l2WEthContract.address,
        value,
        succeed,
        reason,
      });
      return { hash: ZERO_ADDRESS } as TransactionResponse;
    } else {
      return (
        await txnClient.submit(chainId, [
          { contract: l2WEthContract, chainId, method, args: [], value, mrkdwn, message },
        ])
      )[0];
    }
  }
}
