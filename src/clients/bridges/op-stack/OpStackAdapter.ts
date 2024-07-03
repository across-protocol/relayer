import assert from "assert";
import {
  CHAIN_IDs,
  Contract,
  BigNumber,
  BigNumberish,
  TransactionResponse,
  Event,
  checkAddressChecksum,
  ethers,
  spreadEventWithBlockNumber,
  assign,
  winston,
  TOKEN_SYMBOLS_MAP,
} from "../../../utils";
import { SpokePoolClient } from "../../";
import { BaseAdapter } from "../";
import { SortableEvent, OutstandingTransfers } from "../../../interfaces";
import { CONTRACT_ADDRESSES } from "../../../common";
import { OpStackBridge } from "./OpStackBridgeInterface";
import { WethBridge } from "./WethBridge";
import { DefaultERC20Bridge } from "./DefaultErc20Bridge";
import { UsdcTokenSplitterBridge } from "./UsdcTokenSplitterBridge";
import { DaiOptimismBridge, SnxOptimismBridge } from "./optimism";

export class OpStackAdapter extends BaseAdapter {
  public l2Gas: number;
  private readonly defaultBridge: OpStackBridge;
  private readonly customBridges: { [l1Address: string]: OpStackBridge } = {};

  constructor(
    chainId: number,
    logger: winston.Logger,
    supportedTokens: string[],
    readonly spokePoolClients: { [chainId: number]: SpokePoolClient },
    monitoredAddresses: string[]
  ) {
    super(spokePoolClients, chainId, monitoredAddresses, logger, supportedTokens);
    this.l2Gas = 200000;

    const { hubChainId, wethAddress } = this;
    const { OPTIMISM } = CHAIN_IDs;
    if (chainId === OPTIMISM) {
      const mainnetSigner = spokePoolClients[hubChainId].spokePool.signer;
      const l2Signer = spokePoolClients[OPTIMISM].spokePool.signer;

      const dai = TOKEN_SYMBOLS_MAP.DAI.addresses[hubChainId];
      const snx = TOKEN_SYMBOLS_MAP.SNX.addresses[hubChainId];
      this.customBridges[dai] = new DaiOptimismBridge(OPTIMISM, hubChainId, mainnetSigner, l2Signer);
      this.customBridges[snx] = new SnxOptimismBridge(OPTIMISM, hubChainId, mainnetSigner, l2Signer);
    }

    // Typically, a custom WETH bridge is not provided, so use the standard one.
    if (wethAddress) {
      this.customBridges[wethAddress] = new WethBridge(
        this.chainId,
        this.hubChainId,
        this.getSigner(this.hubChainId),
        this.getSigner(chainId)
      );
    }

    // We should manually override the bridge for USDC to use CCTP if this chain has a Native USDC entry. We can
    // assume that all Op Stack chains will have a bridged USDC.e variant that uses the OVM standard bridge, so we
    // only need to check if a native USDC exists for this chain. If so, then we'll use the TokenSplitter bridge
    // which maps to either the CCTP or OVM Standard bridge depending on the request.
    const usdcAddress = TOKEN_SYMBOLS_MAP.USDC.addresses[this.hubChainId];
    const l2NativeUsdcAddress = TOKEN_SYMBOLS_MAP.USDC.addresses[this.chainId];
    if (usdcAddress && l2NativeUsdcAddress && !this.customBridges[usdcAddress]) {
      this.customBridges[usdcAddress] = new UsdcTokenSplitterBridge(
        this.chainId,
        this.hubChainId,
        this.getSigner(this.hubChainId),
        this.getSigner(chainId)
      );
    }

    this.defaultBridge = new DefaultERC20Bridge(
      this.chainId,
      this.hubChainId,
      this.getSigner(this.hubChainId),
      this.getSigner(chainId)
    );

    // Before using this mapping, we need to verify that every key is a correctly checksummed address.
    assert(
      Object.keys(this.customBridges).every(checkAddressChecksum),
      `Invalid or non-checksummed bridge address in customBridges keys: ${Object.keys(this.customBridges)}`
    );
  }

  async getOutstandingCrossChainTransfers(l1Tokens: string[]): Promise<OutstandingTransfers> {
    const { l1SearchConfig, l2SearchConfig } = this.getUpdatedSearchConfigs();
    const availableL1Tokens = this.filterSupportedTokens(l1Tokens);

    const processEvent = (event: Event) => {
      const eventSpread = spreadEventWithBlockNumber(event) as SortableEvent & {
        _amount: BigNumberish;
        _to: string;
      };
      return {
        amount: eventSpread["_amount"],
        to: eventSpread["_to"],
        ...eventSpread,
      };
    };

    await Promise.all(
      this.monitoredAddresses.map((monitoredAddress) =>
        Promise.all(
          availableL1Tokens.map(async (l1Token) => {
            const bridge = this.getBridge(l1Token);

            const [depositInitiatedResults, depositFinalizedResults] = await Promise.all([
              bridge.queryL1BridgeInitiationEvents(l1Token, monitoredAddress, l1SearchConfig),
              bridge.queryL2BridgeFinalizationEvents(l1Token, monitoredAddress, l2SearchConfig),
            ]);

            Object.entries(depositInitiatedResults).forEach(([l2Token, events]) => {
              assign(this.l1DepositInitiatedEvents, [monitoredAddress, l1Token, l2Token], events.map(processEvent));
            });

            Object.entries(depositFinalizedResults).forEach(([l2Token, events]) => {
              assign(this.l2DepositFinalizedEvents, [monitoredAddress, l1Token, l2Token], events.map(processEvent));
            });
          })
        )
      )
    );

    this.baseL1SearchConfig.fromBlock = l1SearchConfig.toBlock + 1;
    this.baseL1SearchConfig.fromBlock = l2SearchConfig.toBlock + 1;

    return this.computeOutstandingCrossChainTransfers(availableL1Tokens);
  }

  async sendTokenToTargetChain(
    address: string,
    l1Token: string,
    l2Token: string,
    amount: BigNumber,
    simMode = false
  ): Promise<TransactionResponse> {
    const { l2Gas } = this;

    const bridge = this.getBridge(l1Token);

    const { contract, method, args } = bridge.constructL1ToL2Txn(address, l1Token, l2Token, amount, l2Gas);

    // Pad gas when bridging to Optimism/Base: https://community.optimism.io/docs/developers/bedrock/differences
    const gasLimitMultiplier = 1.5;
    return await this._sendTokenToTargetChain(
      l1Token,
      l2Token,
      amount,
      contract,
      method,
      args,
      gasLimitMultiplier,
      ethers.constants.Zero,
      simMode
    );
  }

  async wrapEthIfAboveThreshold(
    threshold: BigNumber,
    target: BigNumber,
    simMode = false
  ): Promise<TransactionResponse | null> {
    const { chainId } = this;

    const ovmWeth = CONTRACT_ADDRESSES[this.chainId].weth;
    const ethBalance = await this.getSigner(chainId).getBalance();
    if (ethBalance.gt(threshold)) {
      const l2Signer = this.getSigner(chainId);
      const contract = new Contract(ovmWeth.address, ovmWeth.abi, l2Signer);
      const value = ethBalance.sub(target);
      this.logger.debug({ at: this.getName(), message: "Wrapping ETH", threshold, target, value, ethBalance });
      return await this._wrapEthIfAboveThreshold(threshold, contract, value, simMode);
    } else {
      this.logger.debug({
        at: this.getName(),
        message: "ETH balance below threshold",
        threshold,
        ethBalance,
      });
    }
    return null;
  }

  async checkTokenApprovals(address: string, l1Tokens: string[]): Promise<void> {
    const l1TokenListToApprove = [];
    // We need to approve the Atomic depositor to bridge WETH to optimism via the ETH route.
    const associatedL1Bridges = l1Tokens.flatMap((l1Token) => {
      const bridges = this.getBridge(l1Token).l1Gateways;
      // Push the l1 token to the list of tokens to approve N times, where N is the number of bridges.
      // I.e. the arrays have to be parallel.
      l1TokenListToApprove.push(...Array(bridges.length).fill(l1Token));
      return bridges;
    });
    await this.checkAndSendTokenApprovals(address, l1TokenListToApprove, associatedL1Bridges);
  }

  getBridge(l1Token: string): OpStackBridge {
    // Before doing a lookup, we must verify that the address is correctly checksummed.
    assert(checkAddressChecksum(l1Token), `Invalid or non-checksummed token address ${l1Token}`);
    return this.customBridges[l1Token] || this.defaultBridge;
  }
}
