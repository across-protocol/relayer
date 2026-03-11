import { RebalanceRoute } from "../utils/interfaces";
import { BaseAdapter, STATUS } from "./baseAdapter";
import {
  bnZero,
  BigNumber,
  assert,
  CCTPV2_FINALITY_THRESHOLD_STANDARD,
  createFormatFunction,
  getCctpDomainForChainId,
  ethers,
  getNetworkName,
  getCctpV2TokenMessenger,
  Contract,
  getProvider,
  getCctpDestinationChainFromDomain,
  chainIsProd,
  getCctpV2MessageTransmitter,
  forEachAsync,
  MAX_SAFE_ALLOWANCE,
  toBN,
  ERC20,
  isDefined,
  delay,
} from "../../utils";
import { CCTP_MAX_SEND_AMOUNT } from "../../common";
import { PRODUCTION_NETWORKS, CCTP_NO_DOMAIN } from "@across-protocol/constants";
import { utils } from "@across-protocol/sdk";
import { MultiCallerClient } from "../../clients/MultiCallerClient";

export class CctpAdapter extends BaseAdapter {
  REDIS_PREFIX = "cctp-bridge:";

  async initialize(availableRoutes: RebalanceRoute[]): Promise<void> {
    if (this.initialized) {
      return;
    }
    await super.initialize(availableRoutes.filter((route) => route.adapter === "cctp"));

    this.availableRoutes.forEach((route) => {
      assert(
        PRODUCTION_NETWORKS[route.sourceChain].cctpDomain !== CCTP_NO_DOMAIN &&
          isDefined(getCctpV2TokenMessenger(route.sourceChain)?.address) &&
          PRODUCTION_NETWORKS[route.destinationChain].cctpDomain !== CCTP_NO_DOMAIN &&
          isDefined(getCctpV2TokenMessenger(route.destinationChain)?.address),
        `CCTP bridge is not supported for route ${route.sourceChain} -> ${route.destinationChain}`
      );
    });
  }

  async setApprovals(): Promise<void> {
    this._assertInitialized();
    this.multicallerClient = new MultiCallerClient(this.logger, this.config.multiCallChunkSize, this.baseSigner);

    // Set Bridge allowances:
    const allChains = new Set<number>([...this.allSourceChains, ...this.allDestinationChains]);
    await forEachAsync(Array.from(allChains), async (chainId) => {
      const connectedSigner = this.baseSigner.connect(await getProvider(chainId));
      if (getCctpV2TokenMessenger(chainId)?.address) {
        const usdc = new Contract(this._getTokenInfo("USDC", chainId).address.toNative(), ERC20.abi, connectedSigner);
        const cctpMessenger = await this._getCctpMessenger(chainId);
        const cctpAllowance = await usdc.allowance(this.baseSignerAddress.toNative(), cctpMessenger.address);
        if (cctpAllowance.lt(toBN(MAX_SAFE_ALLOWANCE).div(2))) {
          this.multicallerClient.enqueueTransaction({
            contract: usdc,
            chainId,
            method: "approve",
            nonMulticall: true,
            unpermissioned: false,
            args: [cctpMessenger.address, MAX_SAFE_ALLOWANCE],
            message: "Approved USDC for CCTP Messenger",
            mrkdwn: "Approved USDC for CCTP Messenger",
          });
        }
      }
    });

    const simMode = !this.config.sendingTransactionsEnabled;
    await this.multicallerClient.executeTxnQueues(simMode);
  }

  async initializeRebalance(rebalanceRoute: RebalanceRoute, amountToTransfer: BigNumber): Promise<BigNumber> {
    this._assertInitialized();
    this._assertRouteIsSupported(rebalanceRoute);
    const { txnHash, amountToReceive } = await this._sendCctpBridge(
      rebalanceRoute.sourceChain,
      rebalanceRoute.destinationChain,
      amountToTransfer
    );
    const cloid = this.getCloidForBridge(rebalanceRoute, txnHash);
    await this._redisCreateOrder(cloid, STATUS.PENDING_BRIDGE_PRE_DEPOSIT, rebalanceRoute, amountToReceive);
    return amountToReceive;
  }

  async updateRebalanceStatuses(): Promise<void> {
    this._assertInitialized();
    const pendingBridges = await this._redisGetPendingBridgesPreDeposit();
    if (pendingBridges.length > 0) {
      this.logger.debug({
        at: "CctpAdapter.updateRebalanceStatuses",
        message: `Found ${pendingBridges.length} pending CCTP bridges`,
        pendingBridges,
      });
    }
    for (const cloid of pendingBridges) {
      const [sourceChainId, txnHash] = cloid.split("-");
      const attestation = await this._getCctpAttestation(txnHash, Number(sourceChainId));
      if (utils.getPendingAttestationStatus(attestation) === "pending") {
        continue;
      }

      // If API attestation is ready, then we need to check whether it has been already finalized:
      const destinationChainId = getCctpDestinationChainFromDomain(
        attestation.decodedMessage.destinationDomain,
        chainIsProd(Number(sourceChainId))
      );
      const { address, abi } = getCctpV2MessageTransmitter(destinationChainId);
      const destinationMessageTransmitter = new Contract(address, abi, await getProvider(destinationChainId));
      const processed = await utils.hasCCTPMessageBeenProcessedEvm(
        attestation.eventNonce,
        destinationMessageTransmitter
      );
      if (!processed) {
        continue;
      }
      // Order is no longer pending, so we can delete it.
      this.logger.debug({
        at: "CctpAdapter.updateRebalanceStatuses",
        message: `Order cloid ${cloid} has been finalized`,
      });
      await this._redisDeleteOrder(cloid, STATUS.PENDING_BRIDGE_PRE_DEPOSIT);
    }
  }

  async sweepIntermediateBalances(): Promise<void> {
    // Does nothing.
    return;
  }

  async getPendingRebalances(): Promise<{ [chainId: number]: { [token: string]: BigNumber } }> {
    this._assertInitialized();
    const timeSinceLastUpdate = Date.now() - this.lastUpdateTimestamp;
    if (this.pendingRebalances && timeSinceLastUpdate < 60 * 1000) {
      this.logger.debug({
        at: "CctpAdapter.getPendingRebalances",
        message: `Recently updated pending rebalances, returning cached pending rebalances (time since last update: ${timeSinceLastUpdate}ms)`,
      });
      return this.pendingRebalances;
    }
    const pendingRebalances: { [chainId: number]: { [token: string]: BigNumber } } = {};

    const pendingBridges = await this._redisGetPendingBridgesPreDeposit();
    if (pendingBridges.length > 0) {
      this.logger.debug({
        at: "CctpAdapter.getPendingRebalances",
        message: `Found ${pendingBridges.length} pending CCTP bridges`,
        pendingBridges,
      });
    }
    for (const cloid of pendingBridges) {
      const [sourceChainId, txnHash] = cloid.split("-");
      // Check if order has already been finalized if its no longer "pending"
      const attestation = await this._getCctpAttestation(txnHash, Number(sourceChainId));
      if (utils.getPendingAttestationStatus(attestation) !== "pending") {
        const destinationChainId = getCctpDestinationChainFromDomain(
          attestation.decodedMessage.destinationDomain,
          chainIsProd(Number(sourceChainId))
        );
        const { address, abi } = getCctpV2MessageTransmitter(destinationChainId);
        const destinationMessageTransmitter = new Contract(address, abi, await getProvider(destinationChainId));
        const processed = await utils.hasCCTPMessageBeenProcessedEvm(
          attestation.eventNonce,
          destinationMessageTransmitter
        );
        if (processed) {
          this.logger.debug({
            at: "CctpAdapter.getPendingRebalances",
            message: `Order cloid ${cloid} has already finalized, skipping incrementing pending rebalances`,
          });
          continue;
        }
      }
      const pendingOrderDetails = await this._redisGetOrderDetails(cloid);
      const { sourceChain, destinationChain, amountToTransfer } = pendingOrderDetails;
      // @dev Temporarily filter out L1->L2 and L2->L1 rebalances because they will already be counted by the
      // AdapterManager and this function is designed to be used in conjunction with the AdapterManager
      // to pain a full picture of all pending rebalances.
      if (sourceChain === this.config.hubPoolChainId || destinationChain === this.config.hubPoolChainId) {
        return;
      }
      pendingRebalances[destinationChain] ??= {};
      pendingRebalances[destinationChain]["USDC"] = (pendingRebalances[destinationChain]?.["USDC"] ?? bnZero).add(
        amountToTransfer
      );
    }

    this.pendingRebalances = pendingRebalances;
    this.lastUpdateTimestamp = Date.now();
    return pendingRebalances;
  }

  async getEstimatedCost(rebalanceRoute: RebalanceRoute, amountToTransfer: BigNumber): Promise<BigNumber> {
    this._assertRouteIsSupported(rebalanceRoute);
    const { sourceChain, destinationChain } = rebalanceRoute;
    const { maxFee } = await this._getCctpV2MaxFee(sourceChain, destinationChain, amountToTransfer);
    return maxFee;
  }

  async getPendingOrders(): Promise<string[]> {
    return this._redisGetPendingBridgesPreDeposit();
  }

  private getCloidForBridge(rebalanceRoute: RebalanceRoute, txnHash: string): string {
    return `${rebalanceRoute.sourceChain}-${txnHash}`;
  }

  private async _getCctpV2MaxFee(
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    originChain: number,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    destinationChain: number,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    amountToBridge: BigNumber
  ): Promise<{
    maxFee: BigNumber;
    finalityThreshold: number;
  }> {
    // @todo: Figure out how to switch to fast mode if the `maxFee` allows for it.
    return {
      maxFee: bnZero,
      finalityThreshold: CCTPV2_FINALITY_THRESHOLD_STANDARD,
    };
    // const { maxFee, finalityThreshold } = await getV2DepositForBurnMaxFee(
    //   this._getTokenInfo("USDC", originChain).address,
    //   originChain,
    //   destinationChain,
    //   amountToBridge,
    // );
    // return { maxFee, finalityThreshold };
  }

  private async _sendCctpBridge(
    originChain: number,
    destinationChain: number,
    amountToBridge: BigNumber
  ): Promise<{
    txnHash: string;
    amountToReceive: BigNumber;
  }> {
    // TODO: In the future, this could re-use a CCTPAdapter function.
    const cctpMessenger = await this._getCctpMessenger(originChain);
    const originUsdcToken = this._getTokenInfo("USDC", originChain).address;
    if (amountToBridge.gt(CCTP_MAX_SEND_AMOUNT)) {
      // TODO: Handle this case by sending multiple transactions.
      throw new Error(
        `Amount to send ${amountToBridge.toString()} is greater than CCTP_MAX_SEND_AMOUNT ${CCTP_MAX_SEND_AMOUNT.toString()}`
      );
    }
    const formatter = createFormatFunction(2, 4, false, this._getTokenInfo("USDC", originChain).decimals);
    const { maxFee, finalityThreshold } = await this._getCctpV2MaxFee(originChain, destinationChain, amountToBridge);
    const transaction = {
      contract: cctpMessenger,
      chainId: originChain,
      method: "depositForBurn",
      unpermissioned: false,
      nonMulticall: true,
      args: [
        amountToBridge,
        getCctpDomainForChainId(destinationChain),
        this.baseSignerAddress.toBytes32(),
        originUsdcToken.toNative(),
        ethers.constants.HashZero, // Anyone can finalize the message on domain when this is set to bytes32(0)
        maxFee,
        finalityThreshold,
      ],
      message: `🎰 Bridged USDC via CCTP from ${getNetworkName(originChain)} to ${getNetworkName(destinationChain)}`,
      mrkdwn: `Bridged ${formatter(amountToBridge.toString())} USDC from ${getNetworkName(
        originChain
      )} to ${getNetworkName(destinationChain)} via CCTP`,
    };
    const hash = await this._submitTransaction(transaction);
    // CCTP Fees are taken out of the source chain deposit so add them here so we end up with the desired input
    // amount on HyperEVM before depositing into Hypercore.
    const amountToReceive = amountToBridge.sub(maxFee);
    return { txnHash: hash, amountToReceive };
  }

  protected async _getCctpMessenger(chainId: number): Promise<Contract> {
    const cctpMessengerAddress = getCctpV2TokenMessenger(chainId);
    const originProvider = await getProvider(chainId);
    return new Contract(
      cctpMessengerAddress.address,
      cctpMessengerAddress.abi,
      this.baseSigner.connect(originProvider)
    );
  }

  private async _getCctpAttestation(txnHash: string, sourceChainId: number, retryCount = 0) {
    if (retryCount > 2) {
      throw new Error(`Failed to get CCTP attestation for txnHash ${txnHash} after ${retryCount} retries`);
    }
    try {
      const attestationResponses = await utils.fetchCctpV2Attestations([txnHash], Number(sourceChainId));
      // We don't batch CCTP bridges so we should only get one attestation per transaction hash.
      assert(
        Object.keys(attestationResponses).length === 1 && attestationResponses[txnHash].messages.length === 1,
        "Expected 1 attestation response"
      );
      return attestationResponses[txnHash].messages[0];
    } catch (error) {
      // This API usually fails with a 4xx error if the DepositForBurn event was just created so we should retry
      // after a short delay.
      await delay(3);
      return this._getCctpAttestation(txnHash, sourceChainId, retryCount + 1);
    }
  }
}
