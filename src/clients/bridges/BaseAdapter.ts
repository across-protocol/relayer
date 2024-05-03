/* eslint-disable @typescript-eslint/ban-types */
import { Provider } from "@ethersproject/abstract-provider";
import { Signer } from "@ethersproject/abstract-signer";
import { AugmentedTransaction, SpokePoolClient, TransactionClient } from "../../clients";
import {
  AnyObject,
  BigNumber,
  bnZero,
  Contract,
  DefaultLogLevels,
  ERC20,
  EventSearchConfig,
  MAX_SAFE_ALLOWANCE,
  MAX_UINT_VAL,
  MakeOptional,
  TransactionResponse,
  ZERO_ADDRESS,
  assert,
  blockExplorerLink,
  compareAddressesSimple,
  formatUnitsForToken,
  getNetworkName,
  matchTokenSymbol,
  runTransaction,
  toBN,
  winston,
  createFormatFunction,
  BigNumberish,
  TOKEN_SYMBOLS_MAP,
  getRedisCache,
} from "../../utils";
import { utils } from "@across-protocol/sdk-v2";

import { CONTRACT_ADDRESSES, TOKEN_APPROVALS_TO_FIRST_ZERO } from "../../common";
import { OutstandingTransfers, SortableEvent } from "../../interfaces";
export interface DepositEvent extends SortableEvent {
  amount: BigNumber;
  to: string;
}

interface Events {
  [address: string]: {
    [l1Token: string]: DepositEvent[];
  };
}

// TODO: make these generic arguments to BaseAdapter.
type SupportedL1Token = string;
type SupportedTokenSymbol = string;

export abstract class BaseAdapter {
  static readonly HUB_CHAIN_ID = 1; // @todo: Make dynamic

  readonly hubChainId = BaseAdapter.HUB_CHAIN_ID;

  baseL1SearchConfig: MakeOptional<EventSearchConfig, "toBlock">;
  baseL2SearchConfig: MakeOptional<EventSearchConfig, "toBlock">;
  readonly wethAddress = TOKEN_SYMBOLS_MAP.WETH.addresses[this.hubChainId];
  readonly atomicDepositorAddress = CONTRACT_ADDRESSES[this.hubChainId].atomicDepositor.address;

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
    this.baseL1SearchConfig = { ...this.getSearchConfig(this.hubChainId) };
    this.baseL2SearchConfig = { ...this.getSearchConfig(this.chainId) };
    this.txnClient = new TransactionClient(logger);
  }

  getSigner(chainId: number): Signer {
    return this.spokePoolClients[chainId].spokePool.signer;
  }

  getProvider(chainId: number): Provider {
    return this.spokePoolClients[chainId].spokePool.provider;
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
    return `l1CanonicalTokenBridgeAllowance_${l1Token}_${await this.getSigner(
      this.hubChainId
    ).getAddress()}_targetContract:${targetContract}`;
  }

  async checkAndSendTokenApprovals(address: string, l1Tokens: string[], associatedL1Bridges: string[]): Promise<void> {
    this.log("Checking and sending token approvals", { l1Tokens, associatedL1Bridges });

    assert(l1Tokens.length === associatedL1Bridges.length, "Token and bridge arrays are not the same length");

    const tokensToApprove: { l1Token: Contract; targetContract: string }[] = [];
    const l1TokenContracts = l1Tokens.map(
      (l1Token) => new Contract(l1Token, ERC20.abi, this.getSigner(this.hubChainId))
    );
    const redis = await getRedisCache(this.logger);
    const allowances = await Promise.all(
      l1TokenContracts.map(async (l1TokenContract, index) => {
        // If there is not both a l1TokenContract and associatedL1Bridges[index] then return a number that wont send
        // an approval transaction. For example not every chain has a bridge contract for every token. In this case
        // we clearly dont want to send any approval transactions.
        if (l1TokenContract && associatedL1Bridges[index]) {
          // Check if we've cached already that this allowance is high enough. Returning null means we won't
          // send an allowance approval transaction.
          if (redis) {
            const key = await this.getAllowanceCacheKey(l1TokenContract.address, associatedL1Bridges[index]);
            const result = await redis.get<string>(key);
            if (result !== null) {
              const savedAllowance = toBN(result);
              if (savedAllowance.gte(toBN(MAX_SAFE_ALLOWANCE))) {
                return null;
              }
            }
          }
          return l1TokenContract.allowance(address, associatedL1Bridges[index]);
        } else {
          return null;
        }
      })
    );

    await utils.forEachAsync(allowances, async (allowance, index) => {
      if (allowance && allowance.lt(toBN(MAX_SAFE_ALLOWANCE))) {
        tokensToApprove.push({ l1Token: l1TokenContracts[index], targetContract: associatedL1Bridges[index] });
      } else {
        // Save allowance in cache with no TTL as these should never decrement.
        if (redis) {
          await redis.set(
            await this.getAllowanceCacheKey(l1TokenContracts[index].address, associatedL1Bridges[index]),
            MAX_SAFE_ALLOWANCE
          );
        }
      }
    });
    if (tokensToApprove.length === 0) {
      this.log("No token bridge approvals needed", { l1Tokens });
      return;
    }

    let mrkdwn = "*Approval transactions:* \n";
    for (const { l1Token, targetContract } of tokensToApprove) {
      const { hubChainId } = this;
      const txs = [];
      if (TOKEN_APPROVALS_TO_FIRST_ZERO[hubChainId]?.includes(l1Token.address)) {
        txs.push(await runTransaction(this.logger, l1Token, "approve", [targetContract, bnZero]));
      }
      txs.push(await runTransaction(this.logger, l1Token, "approve", [targetContract, MAX_UINT_VAL]));
      const receipts = await Promise.all(txs.map((tx) => tx.wait()));
      const hubNetwork = getNetworkName(hubChainId);
      const spokeNetwork = getNetworkName(this.chainId);
      mrkdwn +=
        ` - Approved canonical ${spokeNetwork} token bridge ${blockExplorerLink(targetContract, hubChainId)} ` +
        `to spend ${await l1Token.symbol()} ${blockExplorerLink(l1Token.address, hubChainId)} on ${hubNetwork}.` +
        `tx: ${blockExplorerLink(receipts[receipts.length - 1].transactionHash, hubChainId)}`;
      if (receipts.length > 1) {
        mrkdwn += ` tx (to zero approval first): ${blockExplorerLink(receipts[0].transactionHash, hubChainId)}`;
      }
      mrkdwn += "\n";
    }
    this.log("Approved whitelisted tokens! 💰", { mrkdwn }, "info");
  }

  computeOutstandingCrossChainTransfers(l1Tokens: string[]): OutstandingTransfers {
    const outstandingTransfers: OutstandingTransfers = {};

    for (const monitoredAddress of this.monitoredAddresses) {
      // Skip if there are no deposit events for this address at all.
      if (this.l1DepositInitiatedEvents[monitoredAddress] === undefined) {
        continue;
      }

      if (outstandingTransfers[monitoredAddress] === undefined) {
        outstandingTransfers[monitoredAddress] = {};
      }
      if (this.l2DepositFinalizedEvents[monitoredAddress] === undefined) {
        this.l2DepositFinalizedEvents[monitoredAddress] = {};
      }

      for (const l1Token of l1Tokens) {
        // Skip if there has been no deposits for this token.
        if (this.l1DepositInitiatedEvents[monitoredAddress][l1Token] === undefined) {
          continue;
        }

        // It's okay to not have any finalization events. In that case, all deposits are outstanding.
        if (this.l2DepositFinalizedEvents[monitoredAddress][l1Token] === undefined) {
          this.l2DepositFinalizedEvents[monitoredAddress][l1Token] = [];
        }
        const l2FinalizationSet = this.l2DepositFinalizedEvents[monitoredAddress][l1Token];

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

        // Short circuit early if there are no pending deposits.
        if (pendingDeposits.length === 0) {
          continue;
        }

        const totalAmount = pendingDeposits.reduce((acc, curr) => acc.add(curr.amount), bnZero);
        const depositTxHashes = pendingDeposits.map((deposit) => deposit.transactionHash);
        outstandingTransfers[monitoredAddress][l1Token] = {
          totalAmount,
          depositTxHashes,
        };
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
        ...txnRequest,
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

  abstract getOutstandingCrossChainTransfers(l1Tokens: string[]): Promise<OutstandingTransfers>;

  abstract sendTokenToTargetChain(
    address: string,
    l1Token: string,
    l2Token: string,
    amount: BigNumber,
    simMode: boolean
  ): Promise<TransactionResponse>;

  abstract checkTokenApprovals(address: string, l1Tokens: string[]): Promise<void>;

  abstract wrapEthIfAboveThreshold(
    threshold: BigNumber,
    target: BigNumber,
    simMode: boolean
  ): Promise<TransactionResponse | null>;
}
