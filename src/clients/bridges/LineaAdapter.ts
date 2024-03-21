import * as sdk from "@across-protocol/sdk-v2";
import { CONTRACT_ADDRESSES } from "../../common";
import { OutstandingTransfers } from "../../interfaces";
import {
  BigNumber,
  CHAIN_IDs,
  Contract,
  TOKEN_SYMBOLS_MAP,
  TransactionResponse,
  assert,
  bnZero,
  compareAddressesSimple,
  getTokenAddress,
  isDefined,
  paginatedEventQuery,
  winston,
} from "../../utils";
import { SpokePoolClient } from "../SpokePoolClient";
import { BaseAdapter } from "./BaseAdapter";

export class LineaAdapter extends BaseAdapter {
  readonly l1TokenBridge = CONTRACT_ADDRESSES[this.hubChainId].lineaL1TokenBridge.address;
  readonly l1UsdcBridge = CONTRACT_ADDRESSES[this.hubChainId].lineaL1UsdcBridge.address;

  constructor(
    logger: winston.Logger,
    readonly spokePoolClients: { [chainId: number]: SpokePoolClient },
    monitoredAddresses: string[]
  ) {
    super(spokePoolClients, CHAIN_IDs.LINEA, monitoredAddresses, logger, ["USDC", "USDT", "WETH", "WBTC", "DAI"]);
  }
  async checkTokenApprovals(address: string, l1Tokens: string[]): Promise<void> {
    // Note: Linea has two bridges: one for
    const associatedL1Bridges = l1Tokens
      .map((l1Token) => {
        if (!this.isSupportedToken(l1Token)) {
          return null;
        }
        return this.getL1Bridge(l1Token).address;
      })
      .filter(isDefined);
    await this.checkAndSendTokenApprovals(address, l1Tokens, associatedL1Bridges);
  }

  async wrapEthIfAboveThreshold(
    threshold: BigNumber,
    target: BigNumber,
    simMode: boolean
  ): Promise<TransactionResponse> {
    const { chainId } = this;
    assert(sdk.utils.chainIsLinea(chainId), `ChainId ${chainId} is not supported as a Linea chain`);
    const { address: wethAddress, abi: wethABI } = CONTRACT_ADDRESSES[this.chainId].weth;
    const ethBalance = await this.getSigner(chainId).getBalance();
    if (ethBalance.gt(threshold)) {
      const l2Signer = this.getSigner(chainId);
      const contract = new Contract(wethAddress, wethABI, l2Signer);
      const value = ethBalance.sub(target);
      this.logger.debug({ at: this.getName(), message: "Wrapping ETH", threshold, target, value, ethBalance });
      return this._wrapEthIfAboveThreshold(threshold, contract, value, simMode);
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

  getL2MessageService(): Contract {
    const chainId = this.chainId;
    return new Contract(
      CONTRACT_ADDRESSES[chainId].l2MessageService.address,
      CONTRACT_ADDRESSES[chainId].l2MessageService.abi,
      this.getSigner(chainId)
    );
  }

  getL1MessageService(): Contract {
    const { hubChainId } = this;
    return new Contract(
      CONTRACT_ADDRESSES[hubChainId].lineaMessageService.address,
      CONTRACT_ADDRESSES[hubChainId].lineaMessageService.abi,
      this.getSigner(hubChainId)
    );
  }

  getL1TokenBridge(): Contract {
    const { hubChainId } = this;
    return new Contract(
      this.l1TokenBridge,
      CONTRACT_ADDRESSES[hubChainId].lineaL1TokenBridge.abi,
      this.getSigner(hubChainId)
    );
  }

  getL1UsdcBridge(): Contract {
    const { hubChainId } = this;
    return new Contract(
      this.l1UsdcBridge,
      CONTRACT_ADDRESSES[hubChainId].lineaL1UsdcBridge.abi,
      this.getSigner(hubChainId)
    );
  }

  getL2TokenBridge(): Contract {
    const chainId = this.chainId;
    return new Contract(
      CONTRACT_ADDRESSES[chainId].lineaL2TokenBridge.address,
      CONTRACT_ADDRESSES[chainId].lineaL2TokenBridge.abi,
      this.getSigner(chainId)
    );
  }

  getL2UsdcBridge(): Contract {
    const chainId = this.chainId;
    return new Contract(
      CONTRACT_ADDRESSES[chainId].lineaL2UsdcBridge.address,
      CONTRACT_ADDRESSES[chainId].lineaL2UsdcBridge.abi,
      this.getSigner(chainId)
    );
  }

  getL2Bridge(l1Token: string): Contract {
    return this.isUsdc(l1Token) ? this.getL2UsdcBridge() : this.getL2TokenBridge();
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

  isUsdc(l1Token: string): boolean {
    return compareAddressesSimple(l1Token, TOKEN_SYMBOLS_MAP.USDC.addresses[this.hubChainId]);
  }

  getL1Bridge(l1Token: string): Contract {
    return this.isWeth(l1Token)
      ? this.getAtomicDepositor()
      : this.isUsdc(l1Token)
      ? this.getL1UsdcBridge()
      : this.getL1TokenBridge();
  }

  async getOutstandingCrossChainTransfers(l1Tokens: string[]): Promise<sdk.interfaces.OutstandingTransfers> {
    const outstandingTransfers: OutstandingTransfers = {};
    const { l1SearchConfig, l2SearchConfig } = this.getUpdatedSearchConfigs();
    await sdk.utils.mapAsync(this.monitoredAddresses, async (address) => {
      await sdk.utils.mapAsync(l1Tokens, async (l1Token) => {
        if (this.isWeth(l1Token)) {
          const atomicDepositor = this.getAtomicDepositor();
          const l1MessageService = this.getL1MessageService();
          const l2MessageService = this.getL2MessageService();

          // We need to do the following sequential steps.
          // 1. Get all initiated MessageSent events from the L1MessageService where the 'from' address is
          //    the AtomicDepositor and the 'to' address is the user's address.
          // 2. Pipe the resulting _messageHash argument from step 1 into the MessageClaimed event filter
          // 3. For each MessageSent, match the _messageHash to the _messageHash in the MessageClaimed event
          //    any unmatched MessageSent events are considered outstanding transfers.
          const initiatedQueryResult = await paginatedEventQuery(
            l1MessageService,
            l1MessageService.filters.MessageSent(atomicDepositor.address, address),
            l1SearchConfig
          );
          const internalMessageHashes = initiatedQueryResult.map(({ args }) => args._messageHash);
          const finalizedQueryResult = await paginatedEventQuery(
            l2MessageService,
            // Passing in an array of message hashes results in an OR filter
            l2MessageService.filters.MessageClaimed(internalMessageHashes),
            l2SearchConfig
          );
          initiatedQueryResult
            .filter(
              ({ args }) =>
                !finalizedQueryResult.some(
                  (finalizedEvent) => args._messageHash.toLowerCase() === finalizedEvent.args._messageHash.toLowerCase()
                )
            )
            .forEach((event) => {
              const txHash = event.transactionHash;
              const amount = event.args._value;
              outstandingTransfers[address] ??= {
                [l1Token]: { totalAmount: bnZero, depositTxHashes: [] },
              };
              outstandingTransfers[address][l1Token] = {
                totalAmount: outstandingTransfers[address][l1Token].totalAmount.add(amount),
                depositTxHashes: [...outstandingTransfers[address][l1Token].depositTxHashes, txHash],
              };
            });
        } else {
          const isUsdc = this.isUsdc(l1Token);
          const l2Token = getTokenAddress(l1Token, this.hubChainId, this.chainId);
          const l1Bridge = this.getL1Bridge(l1Token);
          const l2Bridge = this.getL2Bridge(l1Token);

          // Define the initialized and finalized event filters for the L1 and L2 bridges
          const [filterL1, filterL2] = isUsdc
            ? [l1Bridge.filters.Deposited(address, null, address), l2Bridge.filters.ReceivedFromOtherLayer(address)]
            : [l1Bridge.filters.BridgingInitiated(address, null, l2Token), l2Bridge.filters.BridgingFinalized(l1Token)];

          const [initiatedQueryResult, finalizedQueryResult] = await Promise.all([
            paginatedEventQuery(l1Bridge, filterL1, l1SearchConfig),
            paginatedEventQuery(l2Bridge, filterL2, l2SearchConfig),
          ]);
          initiatedQueryResult
            .filter(
              (initialEvent) =>
                !isDefined(
                  finalizedQueryResult.find((finalEvent) =>
                    isUsdc
                      ? finalEvent.args.amount.eq(initialEvent.args.amount) &&
                        compareAddressesSimple(initialEvent.args.to, finalEvent.args.recipient)
                      : finalEvent.args.amount.eq(initialEvent.args.amount) &&
                        compareAddressesSimple(initialEvent.args.recipient, finalEvent.args.recipient) &&
                        compareAddressesSimple(finalEvent.args.nativeToken, initialEvent.args.token)
                  )
                )
            )
            .forEach((initialEvent) => {
              const txHash = initialEvent.transactionHash;
              const amount = initialEvent.args.amount;
              outstandingTransfers[address] ??= {
                [l1Token]: { totalAmount: bnZero, depositTxHashes: [] },
              };
              outstandingTransfers[address][l1Token] = {
                totalAmount: outstandingTransfers[address][l1Token].totalAmount.add(amount),
                depositTxHashes: [...outstandingTransfers[address][l1Token].depositTxHashes, txHash],
              };
            });
        }
      });
    });
    return outstandingTransfers;
  }

  sendTokenToTargetChain(
    address: string,
    l1Token: string,
    l2Token: string,
    amount: BigNumber,
    simMode: boolean
  ): Promise<TransactionResponse> {
    const isWeth = this.isWeth(l1Token);
    const isUsdc = this.isUsdc(l1Token);
    const l1Bridge = this.getL1Bridge(l1Token);
    const l1BridgeMethod = isWeth ? "bridgeWethToLinea" : isUsdc ? "depositTo" : "bridgeToken";
    const l1BridgeArgs = isUsdc || isWeth ? [amount, address] : [l1Token, amount, address];
    return this._sendTokenToTargetChain(
      l1Token,
      l2Token,
      amount,
      l1Bridge,
      l1BridgeMethod,
      l1BridgeArgs,
      2,
      bnZero,
      simMode
    );
  }
}
