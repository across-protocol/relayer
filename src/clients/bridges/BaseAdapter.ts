/* eslint-disable @typescript-eslint/ban-types */
import { Provider } from "@ethersproject/abstract-provider";
import { Signer } from "@ethersproject/abstract-signer";
import { constants as sdkConstants } from "@across-protocol/sdk-v2";
import { AugmentedTransaction, SpokePoolClient, TransactionClient } from "../../clients";
import {
  toBN,
  MAX_SAFE_ALLOWANCE,
  Contract,
  ERC20,
  winston,
  EventSearchConfig,
  DefaultLogLevels,
  MakeOptional,
  AnyObject,
  BigNumber,
  matchTokenSymbol,
  ZERO_ADDRESS,
  assert,
  compareAddressesSimple,
  formatUnitsForToken,
  etherscanLink,
  getNetworkName,
  MAX_UINT_VAL,
  TransactionResponse,
  runTransaction,
} from "../../utils";

import { OutstandingTransfers, SortableEvent } from "../../interfaces";
import { CONTRACT_ADDRESSES } from "../../common";
import { BigNumberish, createFormatFunction } from "../../utils/FormattingUtils";
interface DepositEvent extends SortableEvent {
  amount: BigNumber;
  to: string;
}

interface Events {
  [address: string]: {
    [l1Token: string]: DepositEvent[];
  };
}

const { TOKEN_SYMBOLS_MAP } = sdkConstants;

// TODO: make these generic arguments to BaseAdapter.
type SupportedL1Token = string;
type SupportedTokenSymbol = string;

export abstract class BaseAdapter {
  static readonly HUB_CHAIN_ID = 1; // @todo: Make dynamic

  readonly hubChainId = BaseAdapter.HUB_CHAIN_ID;

  chainId: number;
  baseL1SearchConfig: MakeOptional<EventSearchConfig, "toBlock">;
  baseL2SearchConfig: MakeOptional<EventSearchConfig, "toBlock">;
  readonly wethAddress = TOKEN_SYMBOLS_MAP.WETH.addresses[this.hubChainId];
  readonly atomicDepositorAddress = CONTRACT_ADDRESSES[this.hubChainId].atomicDepositor.address;

  l1DepositInitiatedEvents: Events = {};
  l2DepositFinalizedEvents: Events = {};

  txnClient: TransactionClient;

  constructor(
    readonly spokePoolClients: { [chainId: number]: SpokePoolClient },
    _chainId: number,
    readonly monitoredAddresses: string[],
    readonly logger: winston.Logger,
    readonly supportedTokens: SupportedTokenSymbol[]
  ) {
    this.chainId = _chainId;
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
    // Update search range based on the latest data from corresponding SpokePoolClients' search ranges.
    const l1LatestBlock = this.spokePoolClients[this.hubChainId].latestBlockNumber;
    const l2LatestBlock = this.spokePoolClients[this.chainId].latestBlockNumber;
    if (l1LatestBlock === 0 || l2LatestBlock === 0) {
      throw new Error("One or more SpokePoolClients have not been updated");
    }

    return {
      l1SearchConfig: {
        ...this.baseL1SearchConfig,
        fromBlock: this.baseL1SearchConfig.toBlock
          ? this.baseL1SearchConfig.toBlock + 1
          : this.baseL1SearchConfig.fromBlock,
        toBlock: l1LatestBlock,
      },
      l2SearchConfig: {
        ...this.baseL2SearchConfig,
        fromBlock: this.baseL2SearchConfig.toBlock
          ? this.baseL2SearchConfig.toBlock + 1
          : this.baseL2SearchConfig.fromBlock,
        toBlock: l2LatestBlock,
      },
    };
  }

  getSearchConfig(chainId: number): MakeOptional<EventSearchConfig, "toBlock"> {
    return { ...this.spokePoolClients[chainId].eventSearchConfig };
  }

  async checkAndSendTokenApprovals(address: string, l1Tokens: string[], associatedL1Bridges: string[]): Promise<void> {
    this.log("Checking and sending token approvals", { l1Tokens, associatedL1Bridges });
    const tokensToApprove: { l1Token: Contract; targetContract: string }[] = [];
    const l1TokenContracts = l1Tokens.map(
      (l1Token) => new Contract(l1Token, ERC20.abi, this.getSigner(this.hubChainId))
    );
    const allowances = await Promise.all(
      l1TokenContracts.map((l1TokenContract, index) => {
        // If there is not both a l1TokenContract and associatedL1Bridges[index] then return a number that wont send
        // an approval transaction. For example not every chain has a bridge contract for every token. In this case
        // we clearly dont want to send any approval transactions.
        if (l1TokenContract && associatedL1Bridges[index]) {
          return l1TokenContract.allowance(address, associatedL1Bridges[index]);
        } else {
          return null;
        }
      })
    );

    allowances.forEach((allowance, index) => {
      if (allowance && allowance.lt(toBN(MAX_SAFE_ALLOWANCE))) {
        tokensToApprove.push({ l1Token: l1TokenContracts[index], targetContract: associatedL1Bridges[index] });
      }
    });

    if (tokensToApprove.length == 0) {
      this.log("No token bridge approvals needed", { l1Tokens });
      return;
    }

    let mrkdwn = "*Approval transactions:* \n";
    for (const { l1Token, targetContract } of tokensToApprove) {
      const tx = await runTransaction(this.logger, l1Token, "approve", [targetContract, MAX_UINT_VAL]);
      const receipt = await tx.wait();
      const { hubChainId } = this;
      const hubNetwork = getNetworkName(hubChainId);
      const spokeNetwork = getNetworkName(this.chainId);
      mrkdwn +=
        ` - Approved canonical ${spokeNetwork} token bridge ${etherscanLink(targetContract, hubChainId)} ` +
        `to spend ${await l1Token.symbol()} ${etherscanLink(l1Token.address, hubChainId)} on ${hubNetwork}.` +
        `tx: ${etherscanLink(receipt.transactionHash, hubChainId)}\n`;
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

        const totalAmount = pendingDeposits.reduce((acc, curr) => acc.add(curr.amount), toBN(0));
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

    // If we don't have a symbol for this token, return that the token is not supported
    if (relevantSymbols.length === 0) {
      return false;
    }

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
    const _txnRequest: AugmentedTransaction = {
      contract,
      chainId: this.hubChainId,
      method,
      args,
      gasLimitMultiplier,
      value: msgValue,
    };
    const { reason, succeed, transaction: txnRequest } = (await this.txnClient.simulate([_txnRequest]))[0];
    const { contract: targetContract, ...txnRequestData } = txnRequest;
    if (!succeed) {
      const message = `Failed to simulate ${method} deposit from ${txnRequest.chainId} for mainnet token ${l1Token}`;
      this.logger.warn({ at: this.getName(), message, reason, contract: targetContract.address, txnRequestData });
      throw new Error(`${message} (${reason})`);
    }

    const tokenSymbol = matchTokenSymbol(l1Token, this.hubChainId)[0];
    const message = `💌⭐️ Bridging tokens from ${this.hubChainId} to ${this.chainId}`;
    this.logger.debug({
      at: `${this.getName()}#_sendTokenToTargetChain`,
      message,
      l1Token,
      l2Token,
      amount,
      contract: contract.address,
      txnRequestData,
      mrkdwn: `Sent ${formatUnitsForToken(tokenSymbol, amount)} ${tokenSymbol} to chain ${this.chainId}`,
    });
    if (simMode) {
      this.logger.debug({
        at: `${this.getName()}#_sendTokenToTargetChain`,
        message: "Simulation result",
        succeed,
      });
      return { hash: ZERO_ADDRESS } as TransactionResponse;
    }
    return (await this.txnClient.submit(this.hubChainId, [{ ...txnRequest, message }]))[0];
  }

  async _wrapEthIfAboveThreshold(
    wrapThreshold: BigNumber,
    l2WEthContract: Contract,
    value: BigNumber,
    simMode = false
  ): Promise<TransactionResponse> {
    const { chainId, txnClient } = this;
    const method = "deposit";
    const mrkdwn =
      `Ether on chain ${this.chainId} was wrapped due to being over the threshold of ` +
      `${createFormatFunction(2, 4, false, 18)(toBN(wrapThreshold).toString())} ETH.`;
    const message = `Eth wrapped on target chain ${this.chainId}🎁`;
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

  abstract wrapEthIfAboveThreshold(threshold: BigNumber, simMode: boolean): Promise<TransactionResponse | null>;
}
