import assert from "assert";
import {
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
import { SpokePoolClient } from "../..";
import { BaseAdapter } from "..";
import { SortableEvent, OutstandingTransfers } from "../../../interfaces";
import { CONTRACT_ADDRESSES } from "../../../common";
import { OpStackBridge } from "./OpStackBridgeInterface";
import { WethBridge } from "./WethBridge";
import { DefaultERC20Bridge } from "./DefaultErc20Bridge";

export class OpStackAdapter extends BaseAdapter {
  public l2Gas: number;
  private readonly defaultBridge: OpStackBridge;

  constructor(
    chainId: number,
    private customBridges: { [l1Address: string]: OpStackBridge },
    logger: winston.Logger,
    supportedTokens: string[],
    readonly spokePoolClients: { [chainId: number]: SpokePoolClient },
    monitoredAddresses: string[]
  ) {
    // This is the only chain adapter where we do care about the atomic weth depositor
    // and not just the relayer address. This is because the L1 event
    // ETHDepositInitiated and the L2 event DepositFinalized both index on the
    // fromAddress which is the AtomicWethDepositor.
    super(spokePoolClients, chainId, monitoredAddresses, logger, supportedTokens);
    this.l2Gas = 200000;

    // Typically, a custom WETH bridge is not provided, so use the standard one.
    const wethAddress = this.getL1Weth();
    if (wethAddress && !this.customBridges[wethAddress]) {
      this.customBridges[wethAddress] = new WethBridge(
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

  getL1Weth(): string {
    return TOKEN_SYMBOLS_MAP.WETH.addresses[this.hubChainId];
  }

  async getOutstandingCrossChainTransfers(l1Tokens: string[]): Promise<OutstandingTransfers> {
    const { l1SearchConfig, l2SearchConfig } = this.getUpdatedSearchConfigs();

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
          l1Tokens.map(async (l1Token) => {
            const isWeth = l1Token === this.getL1Weth();
            // If token is WETH then we only care to monitor the atomic weth depositor address.
            if (isWeth && monitoredAddress !== BaseAdapter.ATOMIC_DEPOSITOR_ADDRESS) {
              return;
            }
            // If token is not weth, then we do not care about the atomic weth depositor address.
            if (!isWeth && monitoredAddress === BaseAdapter.ATOMIC_DEPOSITOR_ADDRESS) {
              return;
            }
            const bridge = this.getBridge(l1Token);

            const [depositInitiatedResults, depositFinalizedResults] = await Promise.all([
              bridge.queryL1BridgeInitiationEvents(l1Token, monitoredAddress, l1SearchConfig),
              bridge.queryL2BridgeFinalizationEvents(l1Token, monitoredAddress, l2SearchConfig),
            ]);

            // If l1Token is WETH then always map the transfer information to the relayer/signer address, not the
            // atomic weth depositor contract address which is the `monitoredAddress` used to catch the
            // transfer events. The following event filters are designed only to catch transfers initiated by an EOA on
            // L1 sending WETH via the AtomicWethDepositor and receiving ETH on the L2 side at their EOA.
            const relayerAddress = isWeth ? await this.getSigner(this.chainId).getAddress() : monitoredAddress;
            assign(this.l1DepositInitiatedEvents, [relayerAddress, l1Token], depositInitiatedResults.map(processEvent));
            assign(this.l2DepositFinalizedEvents, [relayerAddress, l1Token], depositFinalizedResults.map(processEvent));
          })
        )
      )
    );

    this.baseL1SearchConfig.fromBlock = l1SearchConfig.toBlock + 1;
    this.baseL1SearchConfig.fromBlock = l2SearchConfig.toBlock + 1;

    return this.computeOutstandingCrossChainTransfers(l1Tokens);
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
    assert([10, 8453].includes(chainId), `chainId ${chainId} is not supported`);

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
    // We need to approve the Atomic depositor to bridge WETH to optimism via the ETH route.
    const associatedL1Bridges = l1Tokens.map((l1Token) => this.getBridge(l1Token).l1Gateway);
    await this.checkAndSendTokenApprovals(address, l1Tokens, associatedL1Bridges);
  }

  getBridge(l1Token: string): OpStackBridge {
    // Before doing a lookup, we must verify that the address is correctly checksummed.
    assert(checkAddressChecksum(l1Token), `Invalid or non-checksummed token address ${l1Token}`);
    return this.customBridges[l1Token] || this.defaultBridge;
  }
}
