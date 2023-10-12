import { utils as sdkUtils } from "@across-protocol/sdk-v2";
import { constants as ethersConstants } from "ethers";
import { groupBy } from "lodash";
import { Deposit, DepositWithBlock, FillWithBlock, L1Token, RefundRequestWithBlock } from "../interfaces";
import {
  BigNumber,
  RelayerUnfilledDeposit,
  blockExplorerLink,
  buildFillRelayProps,
  buildFillRelayWithUpdatedFeeProps,
  createFormatFunction,
  formatFeePct,
  getBlockForTimestamp,
  getCurrentTime,
  getNetworkName,
  getUnfilledDeposits,
  isDefined,
  isDepositSpedUp,
  toBN,
  toBNWei,
  winston,
} from "../utils";
import { RelayerClients } from "./RelayerClientHelper";
import { RelayerConfig } from "./RelayerConfig";

const zeroFillAmount = sdkUtils.bnOne;
const UNPROFITABLE_DEPOSIT_NOTICE_PERIOD = 60 * 60; // 1 hour

export class Relayer {
  // Track by originChainId since depositId is issued on the origin chain.
  // Key is in the form of "chainId-depositId".
  private fullyFilledDeposits: { [key: string]: boolean } = {};

  constructor(
    readonly relayerAddress: string,
    readonly logger: winston.Logger,
    readonly clients: RelayerClients,
    readonly config: RelayerConfig
  ) {}

  /**
   * @description Retrieve the complete array of unfilled deposits.
   * @returns An array of RelayerUnfilledDeposit objects, filtered by the supported version and deposit routes.
   */
  public async getUnfilledDeposits(): Promise<RelayerUnfilledDeposit[]> {
    const { configStoreClient, hubPoolClient, spokePoolClients } = this.clients;
    const maxVersion = configStoreClient.configStoreVersion;

    const unfilledDeposits = await getUnfilledDeposits(spokePoolClients, hubPoolClient, this.config.maxRelayerLookBack);
    const {
      supportedDeposits = [],
      unsupportedDeposits = [],
      ignoredDeposits = [],
    } = groupBy(unfilledDeposits, ({ deposit, version }) => {
      const { originChainId, destinationChainId } = deposit;
      if (version > maxVersion) {
        return "unsupportedDeposits";
      }

      return this.routeEnabled(originChainId, destinationChainId) ? "supportedDeposits" : "ignoredDeposits";
    });

    if (unsupportedDeposits.length > 0) {
      const deposits = unsupportedDeposits.map(({ deposit, version }) => {
        const { originChainId, depositId, transactionHash } = deposit;
        return { originChainId, depositId, version, transactionHash };
      });
      this.logger.warn({
        at: "Relayer::getUnfilledDeposits",
        message: "Skipping deposits that are not supported by this relayer version.",
        latestVersionSupported: maxVersion,
        latestInConfigStore: configStoreClient.getConfigStoreVersionForTimestamp(),
        deposits,
      });
    }

    if (ignoredDeposits.length > 0) {
      const deposits = ignoredDeposits.map(({ deposit }) => {
        const { originChainId, destinationChainId, depositId, originToken, amount, transactionHash } = deposit;
        return { originChainId, destinationChainId, depositId, originToken, amount, transactionHash };
      });
      this.logger.debug({
        at: "Relayer::getUnfilledDeposits",
        message: `Skipping ${deposits.length} deposits from or to disabled chains.`,
        deposits,
      });
    }

    return supportedDeposits;
  }

  /**
   * @description Validate whether the origin and destination chain combination is permitted by relayer config.
   * @param originChainId chain ID for the deposit.
   * @param destinationChainId Chain ID of a prospective fill.
   * @returns True if the route is permitted by config (or enabled by default), otherwise false.
   */
  routeEnabled(originChainId: number, destinationChainId: number): boolean {
    const { relayerOriginChains: originChains, relayerDestinationChains: destinationChains } = this.config;

    if (originChains?.length > 0 && !originChains.includes(originChainId)) {
      return false;
    }

    if (destinationChains?.length > 0 && !destinationChains.includes(destinationChainId)) {
      return false;
    }

    return true;
  }

  async checkForUnfilledDepositsAndFill(sendSlowRelays = true): Promise<void> {
    // Fetch all unfilled deposits, order by total earnable fee.
    const { config } = this;
    const { acrossApiClient, hubPoolClient, profitClient, spokePoolClients, tokenClient } = this.clients;

    const unfilledDeposits = await this.getUnfilledDeposits();

    // Sum the total unfilled deposit amount per origin chain and set a MDC for that chain.
    const unfilledDepositAmountsPerChain: { [chainId: number]: BigNumber } = unfilledDeposits.reduce((agg, curr) => {
      const unfilledAmountUsd = profitClient.getFillAmountInUsd(curr.deposit, curr.unfilledAmount);
      if (!agg[curr.deposit.originChainId]) {
        agg[curr.deposit.originChainId] = toBN(0);
      }
      agg[curr.deposit.originChainId] = agg[curr.deposit.originChainId].add(unfilledAmountUsd);
      return agg;
    }, {});

    // Sort thresholds in ascending order.
    const minimumDepositConfirmationThresholds = Object.keys(config.minDepositConfirmations)
      .filter((x) => x !== "default")
      .sort((x, y) => Number(x) - Number(y));

    // Set the MDC for each origin chain equal to lowest threshold greater than the unfilled USD deposit amount.
    // If we can't find a threshold greater than the USD amount, then use the default.
    const mdcPerChain = Object.fromEntries(
      Object.entries(unfilledDepositAmountsPerChain).map(([chainId, unfilledAmount]) => {
        const usdThreshold = minimumDepositConfirmationThresholds.find((_usdThreshold) => {
          return toBNWei(_usdThreshold).gte(unfilledAmount);
        });
        // If no thresholds are greater than unfilled amount, then use fallback which should have largest MDCs.
        return [chainId, config.minDepositConfirmations[usdThreshold ?? "default"][chainId]];
      })
    );
    this.logger.debug({
      at: "Relayer",
      message: "Setting minimum deposit confirmation based on origin chain aggregate deposit amount",
      unfilledDepositAmountsPerChain,
      mdcPerChain,
      minDepositConfirmations: config.minDepositConfirmations,
    });

    // Filter out deposits that fall under the following criteria:
    // - Deposit age does not meet the minimum number of confirmations for the corresponding origin chain.
    // - quoteTimestamp is in the future (impossible to know HubPool utilization => LP fee cannot be computed).
    const confirmedUnfilledDeposits = unfilledDeposits
      .filter((x) => {
        return (
          x.deposit.quoteTimestamp + config.quoteTimeBuffer <= hubPoolClient.currentTime &&
          x.deposit.blockNumber <=
            spokePoolClients[x.deposit.originChainId].latestBlockNumber - mdcPerChain[x.deposit.originChainId]
        );
      })
      .sort((a, b) =>
        a.unfilledAmount.mul(a.deposit.relayerFeePct).lt(b.unfilledAmount.mul(b.deposit.relayerFeePct)) ? 1 : -1
      );
    if (confirmedUnfilledDeposits.length > 0) {
      this.logger.debug({
        at: "Relayer",
        message: "Unfilled deposits found",
        number: confirmedUnfilledDeposits.length,
      });
    } else {
      this.logger.debug({ at: "Relayer", message: "No unfilled deposits" });
    }

    // Iterate over all unfilled deposits. For each unfilled deposit: a) check that the token balance client has enough
    // balance to fill the unfilled amount. b) the fill is profitable. If both hold true then fill the unfilled amount.
    // If not enough ballance add the shortfall to the shortfall tracker to produce an appropriate log. If the deposit
    // is has no other fills then send a 0 sized fill to initiate a slow relay. If unprofitable then add the
    // unprofitable tx to the unprofitable tx tracker to produce an appropriate log.
    for (const { deposit, version, unfilledAmount, fillCount, invalidFills } of confirmedUnfilledDeposits) {
      const { relayerTokens, slowDepositors } = config;

      const { originChainId, destinationChainId, originToken } = deposit;
      const destinationChain = getNetworkName(destinationChainId);

      // Skip any L1 tokens that are not specified in the config.
      // If relayerTokens is an empty list, we'll assume that all tokens are supported.
      const l1Token = hubPoolClient.getL1TokenInfoForL2Token(originToken, originChainId);
      if (
        relayerTokens.length > 0 &&
        !relayerTokens.includes(l1Token.address) &&
        !relayerTokens.includes(l1Token.address.toLowerCase())
      ) {
        this.logger.debug({ at: "Relayer", message: "Skipping deposit for unwhitelisted token", deposit, l1Token });
        continue;
      }

      // Skip deposits that contain invalid fills from the same relayer. This prevents potential corrupted data from
      // making the same relayer fill a deposit multiple times.
      if (!config.acceptInvalidFills && invalidFills.some((fill) => fill.relayer === this.relayerAddress)) {
        this.logger.error({
          at: "Relayer",
          message: "👨‍👧‍👦 Skipping deposit with invalid fills from the same relayer",
          deposit,
          invalidFills,
          destinationChain,
        });
        continue;
      }

      // We query the relayer API to get the deposit limits for different token and destination combinations.
      // The relayer should *not* be filling deposits that the HubPool doesn't have liquidity for otherwise the relayer's
      // refund will be stuck for potentially 7 days.
      if (acrossApiClient.updatedLimits && unfilledAmount.gt(acrossApiClient.getLimit(l1Token.address))) {
        this.logger.warn({
          at: "Relayer",
          message: "😱 Skipping deposit with greater unfilled amount than API suggested limit",
          limit: acrossApiClient.getLimit(l1Token.address),
          l1Token: l1Token.address,
          depositId: deposit.depositId,
          amount: deposit.amount,
          unfilledAmount: unfilledAmount.toString(),
          originChainId: deposit.originChainId,
          transactionHash: deposit.transactionHash,
        });
        continue;
      }

      // At this point, check if deposit has a non-empty message.
      // We need to build in better simulation logic for deposits with non-empty messages. Currently we only measure
      // the fill's gas cost against a simple USDC fill with message=0x. This doesn't handle the case where the
      // message is != 0x and it ends up costing a lot of gas to execute, resulting in a big loss to the relayer.
      if (isDepositSpedUp(deposit) && deposit.updatedMessage !== "0x") {
        this.logger.warn({
          at: "Relayer",
          message: "Skipping fill for sped-up deposit with message",
          deposit,
        });
        continue;
      } else if (deposit.message !== "0x") {
        this.logger.warn({
          at: "Relayer",
          message: "Skipping fill for deposit with message",
          deposit,
        });
        continue;
      }

      // If depositor is on the slow deposit list, then send a zero fill to initiate a slow relay and return early.
      if (slowDepositors?.includes(deposit.depositor)) {
        if (sendSlowRelays && fillCount === 0 && tokenClient.hasBalanceForZeroFill(deposit)) {
          this.logger.debug({
            at: "Relayer",
            message: "Initiating slow fill for grey listed depositor",
            depositor: deposit.depositor,
          });
          this.fillRelay(deposit, zeroFillAmount, deposit.destinationChainId);
        }
        // Regardless of whether we should send a slow fill or not for this depositor, exit early at this point
        // so we don't fast fill an already slow filled deposit from the slow fill-only list.
        continue;
      }

      if (tokenClient.hasBalanceForFill(deposit, unfilledAmount)) {
        // The pre-computed realizedLpFeePct is for the pre-UBA fee model. Update it to the UBA fee model if necessary.
        // The SpokePool guarantees the sum of the fees is <= 100% of the deposit amount.
        deposit.realizedLpFeePct = await this.computeRealizedLpFeePct(version, deposit);

        const repaymentChainId = await this.resolveRepaymentChain(version, deposit, unfilledAmount, l1Token);
        if (isDefined(repaymentChainId)) {
          this.fillRelay(deposit, unfilledAmount, repaymentChainId);
        } else {
          profitClient.captureUnprofitableFill(deposit, unfilledAmount);
        }
      } else {
        tokenClient.captureTokenShortfallForFill(deposit, unfilledAmount);
        // If we don't have enough balance to fill the unfilled amount and the fill count on the deposit is 0 then send a
        // 1 wei sized fill to ensure that the deposit is slow relayed. This only needs to be done once.
        if (sendSlowRelays && tokenClient.hasBalanceForZeroFill(deposit) && fillCount === 0) {
          this.fillRelay(deposit, zeroFillAmount, deposit.destinationChainId);
        }
      }
    }
    // If during the execution run we had shortfalls or unprofitable fills then handel it by producing associated logs.
    if (tokenClient.anyCapturedShortFallFills()) {
      this.handleTokenShortfall();
    }
    if (profitClient.anyCapturedUnprofitableFills()) {
      this.handleUnprofitableFill();
    }
  }

  fillRelay(deposit: Deposit, fillAmount: BigNumber, repaymentChainId: number): void {
    // Skip deposits that this relayer has already filled completely before to prevent double filling (which is a waste
    // of gas as the second fill would fail).
    // TODO: Handle the edge case scenario where the first fill failed due to transient errors and needs to be retried
    const fillKey = `${deposit.originChainId}-${deposit.depositId}`;
    if (this.fullyFilledDeposits[fillKey]) {
      this.logger.debug({
        at: "Relayer",
        message: "Skipping deposit already filled by this relayer",
        originChainId: deposit.originChainId,
        depositId: deposit.depositId,
      });
      return;
    }
    const zeroFill = fillAmount.eq(zeroFillAmount);
    this.logger.debug({
      at: "Relayer",
      message: zeroFill ? "Zero filling" : "Filling deposit",
      deposit,
      repaymentChainId
    });

    // If deposit has been sped up, call fillRelayWithUpdatedFee instead. This guarantees that the relayer wouldn't
    // accidentally double fill due to the deposit hash being different - SpokePool contract will check that the
    // original hash with the old fee hasn't been filled.
    const [method, argBuilder, messageModifier] = isDepositSpedUp(deposit)
      ? ["fillRelayWithUpdatedDeposit", buildFillRelayWithUpdatedFeeProps, "with modified parameters "]
      : ["fillRelay", buildFillRelayProps, ""];

    const message = fillAmount.eq(deposit.amount)
      ? `Filled deposit ${messageModifier}🚀`
      : `${zeroFill ? "Zero" : "Partially"} filled deposit ${messageModifier}📫"`;

    this.clients.multiCallerClient.enqueueTransaction({
      contract: this.clients.spokePoolClients[deposit.destinationChainId].spokePool,
      chainId: deposit.destinationChainId,
      method,
      args: argBuilder(deposit, repaymentChainId, fillAmount),
      message,
      mrkdwn: this.constructRelayFilledMrkdwn(deposit, repaymentChainId, fillAmount),
    });

    // TODO: Revisit in the future when we implement partial fills.
    this.fullyFilledDeposits[fillKey] = fillAmount.eq(deposit.amount);

    // Decrement tokens in token client used in the fill. This ensures that we dont try and fill more than we have.
    this.clients.tokenClient.decrementLocalBalance(deposit.destinationChainId, deposit.destinationToken, fillAmount);
  }

  // Strategy for requesting refunds: Query all refunds requests, and match them to fills.
  // The remaining fills are eligible for new requests.
  async requestRefunds(sendRefundRequests = true): Promise<void> {
    const { multiCallerClient, ubaClient } = this.clients;
    const spokePoolClients = Object.values(this.clients.spokePoolClients);
    this.logger.debug({
      at: "Relayer::requestRefunds",
      message: "Evaluating chains for fills with outstanding cross-chain refunds",
      chainIds: spokePoolClients.map(({ chainId }) => chainId),
    });

    const eligibleFillsByRefundChain: { [chainId: number]: FillWithBlock[] } = Object.fromEntries(
      spokePoolClients.map(({ chainId }) => [chainId, []])
    );

    // Bound the event range by the relayer lookback. Must be resolved from an offset (in seconds) to a block number.
    // Guard getBlockForTimestamp() by maxRelayerLookBack, because getBlockForTimestamp() doesn't work in test (yet).
    let fromBlocks: { [chainId: number]: number } = {};
    if (isDefined(this.config.maxRelayerLookBack)) {
      const _fromBlocks = await Promise.all(
        spokePoolClients.map((spokePoolClient) => {
          const currentTime = spokePoolClient.getCurrentTime();
          const { chainId, deploymentBlock } = spokePoolClient;
          return getBlockForTimestamp(chainId, currentTime - this.config.maxRelayerLookBack) ?? deploymentBlock;
        })
      );
      fromBlocks = Object.fromEntries(
        _fromBlocks.map((blockNumber, idx) => [spokePoolClients[idx].chainId, blockNumber])
      );
    }

    const refundRequests = await Promise.all(
      spokePoolClients.map(({ chainId }) => {
        const fromBlock = fromBlocks[chainId];
        return ubaClient.getRefundRequests(chainId, { relayer: this.relayerAddress, fromBlock });
      })
    );

    // For each refund/repayment Spoke Pool, group its set of refund requests by corresponding destination chain.
    const refundRequestsByDstChain: { [chainId: number]: RefundRequestWithBlock[] } = Object.fromEntries(
      spokePoolClients.map(({ chainId }) => [chainId, []])
    );
    refundRequests
      .flat()
      .forEach((refundRequest) => refundRequestsByDstChain[refundRequest.destinationChainId].push(refundRequest));

    // For each destination Spoke Pool, find any fills that are eligible for a new refund request.
    const fills = await Promise.all(
      spokePoolClients.map(({ chainId: destinationChainId }) =>
        this.findFillsWithoutRefundRequests(
          destinationChainId,
          refundRequestsByDstChain[destinationChainId],
          fromBlocks[destinationChainId]
        )
      )
    );
    fills.flat().forEach((fill) => eligibleFillsByRefundChain[fill.repaymentChainId].push(fill));

    // Enqueue a refund for each eligible fill.
    let nRefunds = 0;
    Object.values(eligibleFillsByRefundChain).forEach((fills) => {
      nRefunds += fills.length;
      fills.forEach((fill) => this.requestRefund(fill));
    });

    const message = `${nRefunds === 0 ? "No" : nRefunds} outstanding fills with eligible cross-chain refunds found.`;
    const blockRanges = Object.fromEntries(
      spokePoolClients.map(({ chainId, deploymentBlock, latestBlockNumber }) => {
        return [chainId, [fromBlocks[chainId] ?? deploymentBlock, latestBlockNumber]];
      })
    );
    this.logger.info({ at: "Relayer::requestRefunds", message, blockRanges });

    await multiCallerClient.executeTransactionQueue(!sendRefundRequests);
  }

  async findFillsWithoutRefundRequests(
    destinationChainId: number,
    refundRequests: RefundRequestWithBlock[],
    fromBlock: number
  ): Promise<FillWithBlock[]> {
    const depositIds: { [chainId: number]: number[] } = {};

    refundRequests.forEach(({ originChainId, depositId }) => {
      depositIds[originChainId] ??= [];
      depositIds[originChainId].push(depositId);
    });

    // Find fills where repayment was requested on another chain.
    const filter = { relayer: this.relayerAddress, fromBlock };
    const fills = (await this.clients.ubaClient.getFills(destinationChainId, filter)).filter((fill) => {
      const { depositId, originChainId, destinationChainId, repaymentChainId } = fill;
      return repaymentChainId !== destinationChainId && !depositIds[originChainId]?.includes(depositId);
    });

    if (fills.length > 0) {
      const fillsByChainId: { [chainId: number]: string[] } = {};
      fills.forEach(({ destinationChainId, transactionHash }) => {
        fillsByChainId[destinationChainId] ??= [];
        fillsByChainId[destinationChainId].push(transactionHash);
      });

      this.logger.debug({
        at: "Relayer::findFillsWithoutRefundRequests",
        message: "Found fills eligible for cross-chain refund requests.",
        fills: fillsByChainId,
      });
    }
    return fills;
  }

  protected requestRefund(fill: FillWithBlock): void {
    const { hubPoolClient, multiCallerClient, spokePoolClients } = this.clients;
    const {
      originChainId,
      depositId,
      destinationChainId,
      destinationToken,
      fillAmount: amount,
      realizedLpFeePct,
      repaymentChainId: chainId,
      blockNumber: fillBlock,
    } = fill;

    const contract = spokePoolClients[chainId].spokePool;
    const method = "requestRefund";
    // @todo: Support specifying max impact against the refund amount (i.e. to mitigate price impact by fills).
    const maxCount = ethersConstants.MaxUint256;

    // Resolve the refund token from the fill token. The name getDestinationtTokenForDeposit() is a misnomer here.
    const refundToken = hubPoolClient.getDestinationTokenForDeposit({
      originChainId: destinationChainId,
      originToken: destinationToken,
      destinationChainId: chainId,
    });

    const args = [
      refundToken,
      amount,
      originChainId,
      destinationChainId,
      realizedLpFeePct,
      depositId,
      fillBlock,
      maxCount,
    ];

    const message = `Submitted refund request on chain ${getNetworkName(chainId)}.`;
    const mrkdwn = this.constructRefundRequestMarkdown(fill);

    this.logger.debug({ at: "Relayer::requestRefund", message: "Requesting refund for fill.", fill });
    multiCallerClient.enqueueTransaction({ chainId, contract, method, args, message, mrkdwn });
  }

  protected async resolveRepaymentChain(
    version: number,
    deposit: DepositWithBlock,
    fillAmount: BigNumber,
    hubPoolToken: L1Token
  ): Promise<number | undefined> {
    const { depositId, originChainId, destinationChainId, transactionHash: depositHash } = deposit;
    const { inventoryClient, profitClient } = this.clients;

    // TODO: Consider adding some way for Relayer to delete transactions in Queue for fills for same deposit.
    // This way the relayer could set a repayment chain ID for any fill that follows a 1 wei fill in the queue.
    // This isn't implemented due to complexity because its a very rare case in production, because its very
    // unlikely that a relayer could enqueue a 1 wei fill (lacking balance to fully fill it) for a deposit and
    // then later on in the run have enough balance to fully fill it.
    const fillsInQueueForSameDeposit = this.clients.multiCallerClient
      .getQueuedTransactions(deposit.destinationChainId)
      .some(({ method, args }) => {
        return (
          (method === "fillRelay" && args[9] === depositId && args[6] === originChainId) ||
          (method === "fillRelayWithUpdatedDeposit" && args[11] === depositId && args[7] === originChainId)
        );
      });

    if (!fillAmount.eq(deposit.amount) || fillsInQueueForSameDeposit) {
      const originChain = getNetworkName(originChainId);
      const destinationChain = getNetworkName(destinationChainId);
      this.logger.debug({
        at: "Relayer",
        message: `Skipping repayment chain determination for partial fill on ${destinationChain}`,
        deposit: { originChain, depositId, destinationChain, depositHash },
      });
      return destinationChainId;
    }

    const preferredChainId = await inventoryClient.determineRefundChainId(deposit, hubPoolToken.address);
    const refundFee = this.computeRefundFee(version, deposit);

    const profitable = profitClient.isFillProfitable(deposit, fillAmount, refundFee, hubPoolToken);
    return profitable ? preferredChainId : undefined;
  }

  protected async computeRealizedLpFeePct(version: number, deposit: DepositWithBlock): Promise<BigNumber> {
    if (!sdkUtils.isUBA(version)) {
      if (deposit.realizedLpFeePct === undefined) {
        throw new Error(`Deposit ${deposit.depositId} is missing realizedLpFeePct`);
      }
      return deposit.realizedLpFeePct;
    }

    const { depositId } = deposit;
    const { depositBalancingFee, lpFee } = this.clients.ubaClient.computeFeesForDeposit(deposit);
    const realizedLpFeePct = depositBalancingFee.add(lpFee);

    const chain = getNetworkName(deposit.originChainId);
    this.logger.debug({
      at: "relayer::computeRealizedLpFeePct",
      message: `Computed UBA system fee for ${chain} depositId ${depositId}: ${realizedLpFeePct}`,
    });

    return realizedLpFeePct;
  }

  protected computeRefundFee(version: number, deposit: DepositWithBlock): BigNumber {
    if (!sdkUtils.isUBA(version)) {
      return toBN(0);
    }
    const tokenSymbol = this.clients.hubPoolClient.getL1TokenInfoForL2Token(
      deposit.originToken,
      deposit.originChainId
    )?.symbol;
    const relayerBalancingFee = this.clients.ubaClient.computeBalancingFeeForNextRefund(
      deposit.destinationChainId,
      tokenSymbol,
      deposit.amount
    );
    return relayerBalancingFee;
  }

  private handleTokenShortfall() {
    const tokenShortfall = this.clients.tokenClient.getTokenShortfall();

    let mrkdwn = "";
    Object.entries(tokenShortfall).forEach(([_chainId, shortfallForChain]) => {
      const chainId = Number(_chainId);
      mrkdwn += `*Shortfall on ${getNetworkName(chainId)}:*\n`;
      Object.entries(shortfallForChain).forEach(([token, { shortfall, balance, needed, deposits }]) => {
        const { symbol, decimals } = this.clients.hubPoolClient.getTokenInfo(chainId, token);
        const formatter = createFormatFunction(2, 4, false, decimals);
        let crossChainLog = "";
        if (this.clients.inventoryClient.isInventoryManagementEnabled() && chainId !== 1) {
          const l1Token = this.clients.hubPoolClient.getL1TokenInfoForL2Token(token, chainId);
          crossChainLog =
            "There is " +
            formatter(
              this.clients.inventoryClient.crossChainTransferClient
                .getOutstandingCrossChainTransferAmount(this.relayerAddress, chainId, l1Token.address)
                .toString()
            ) +
            ` inbound L1->L2 ${symbol} transfers. `;
        }
        mrkdwn +=
          ` - ${symbol} cumulative shortfall of ` +
          `${formatter(shortfall.toString())} ` +
          `(have ${formatter(balance.toString())} but need ` +
          `${formatter(needed.toString())}). ${crossChainLog}` +
          `This is blocking deposits: ${deposits}.\n`;
      });
    });

    this.logger.warn({ at: "Relayer", message: "Insufficient balance to fill all deposits 💸!", mrkdwn });
  }

  private handleUnprofitableFill() {
    const unprofitableDeposits = this.clients.profitClient.getUnprofitableFills();

    let mrkdwn = "";
    Object.keys(unprofitableDeposits).forEach((chainId) => {
      let depositMrkdwn = "";
      Object.keys(unprofitableDeposits[chainId]).forEach((depositId) => {
        const unprofitableDeposit = unprofitableDeposits[chainId][depositId];
        const deposit: DepositWithBlock = unprofitableDeposit.deposit;
        const fillAmount: BigNumber = unprofitableDeposit.fillAmount;
        // Skip notifying if the unprofitable fill happened too long ago to avoid spamming.
        if (deposit.quoteTimestamp + UNPROFITABLE_DEPOSIT_NOTICE_PERIOD < getCurrentTime()) {
          return;
        }

        const gasCost = this.clients.profitClient.getTotalGasCost(deposit.destinationChainId).toString();
        const { symbol, decimals } = this.clients.hubPoolClient.getTokenInfoForDeposit(deposit);
        const formatFunction = createFormatFunction(2, 4, false, decimals);
        const gasFormatFunction = createFormatFunction(2, 10, false, 18);
        const depositblockExplorerLink = blockExplorerLink(deposit.transactionHash, deposit.originChainId);
        depositMrkdwn +=
          `- DepositId ${deposit.depositId} (tx: ${depositblockExplorerLink}) of amount ${formatFunction(
            deposit.amount.toString()
          )} ${symbol}` +
          ` with a relayerFeePct ${formatFeePct(deposit.relayerFeePct)}% and gas cost ${gasFormatFunction(gasCost)}` +
          ` from ${getNetworkName(deposit.originChainId)} to ${getNetworkName(deposit.destinationChainId)}` +
          ` and an unfilled amount of ${formatFunction(fillAmount.toString())} ${symbol} is unprofitable!\n`;
      });

      if (depositMrkdwn) {
        mrkdwn += `*Unprofitable deposits on ${getNetworkName(chainId)}:*\n` + depositMrkdwn;
      }
    });

    if (mrkdwn) {
      this.logger.warn({ at: "Relayer", message: "Not relaying unprofitable deposits 🙅‍♂️!", mrkdwn });
    }
  }

  private constructRelayFilledMrkdwn(deposit: Deposit, repaymentChainId: number, fillAmount: BigNumber): string {
    let mrkdwn =
      this.constructBaseFillMarkdown(deposit, fillAmount) + ` Relayer repayment: ${getNetworkName(repaymentChainId)}.`;

    if (isDepositSpedUp(deposit)) {
      mrkdwn += ` Modified relayer fee: ${formatFeePct(deposit.newRelayerFeePct)}%.`;
    }

    return mrkdwn;
  }

  private constructBaseFillMarkdown(deposit: Deposit, fillAmount: BigNumber): string {
    const { symbol, decimals } = this.clients.hubPoolClient.getTokenInfoForDeposit(deposit);
    const srcChain = getNetworkName(deposit.originChainId);
    const dstChain = getNetworkName(deposit.destinationChainId);
    const amount = createFormatFunction(2, 4, false, decimals)(deposit.amount.toString());
    const depositor = blockExplorerLink(deposit.depositor, deposit.originChainId);
    const _fillAmount = createFormatFunction(2, 4, false, decimals)(fillAmount.toString());
    const relayerFeePct = formatFeePct(deposit.relayerFeePct);
    const realizedLpFeePct = formatFeePct(deposit.realizedLpFeePct);

    let msg =
      `Relayed depositId ${deposit.depositId} from ${srcChain} to ${dstChain} of ${amount} ${symbol},` +
      ` with depositor ${depositor}. Fill amount of ${_fillAmount} ${symbol} with` +
      ` relayerFee ${relayerFeePct}% & realizedLpFee ${realizedLpFeePct}%.`;
    if (fillAmount.eq(zeroFillAmount)) {
      msg += "Has been relayed with 0 size due to a token shortfall! This will initiate a slow relay for this deposit.";
    }

    return msg;
  }

  private constructRefundRequestMarkdown(fill: FillWithBlock): string {
    const { hubPoolClient } = this.clients;
    const { depositId, destinationChainId, destinationToken } = fill;

    const { symbol, decimals } = hubPoolClient.getL1TokenInfoForL2Token(destinationToken, destinationChainId);

    const refundChain = getNetworkName(fill.repaymentChainId);
    const originChain = getNetworkName(fill.originChainId);
    const destinationChain = getNetworkName(destinationChainId);

    const _fillAmount = createFormatFunction(2, 4, false, decimals)(fill.fillAmount.toString());

    return (
      `🌈 Requested refund on ${refundChain} for ${_fillAmount} ${symbol} for ${originChain} depositId ${depositId},` +
      ` filled on ${destinationChain}, with relayerFee ${formatFeePct(fill.relayerFeePct)}%.`
    );
  }
}
