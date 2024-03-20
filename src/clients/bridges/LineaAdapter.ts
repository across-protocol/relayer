import {
  BigNumber,
  CHAIN_IDs,
  Contract,
  TOKEN_SYMBOLS_MAP,
  TransactionResponse,
  assert,
  bnZero,
  compareAddressesSimple,
  isDefined,
  winston,
} from "../../utils";
import { SpokePoolClient } from "../SpokePoolClient";
import { BaseAdapter } from "./BaseAdapter";
import { CONTRACT_ADDRESSES } from "../../common";
import * as sdk from "@across-protocol/sdk-v2";

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

  getOutstandingCrossChainTransfers(l1Tokens: string[]): Promise<sdk.interfaces.OutstandingTransfers> {
    throw new Error("Method not implemented.");
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
