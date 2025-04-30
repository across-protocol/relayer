import axios from "axios";
import {
  Contract,
  BigNumber,
  EventSearchConfig,
  Signer,
  Provider,
  EvmAddress,
  getTokenInfo,
  assert,
  isDefined,
  chainIsProd,
  getTimestampForBlock,
  mapAsync,
  ethers,
  toBN,
  ConvertDecimals,
} from "../../utils";
import { BaseBridgeAdapter, BridgeTransactionDetails, BridgeEvents } from "./BaseBridgeAdapter";
import { hmac } from "../utils";
import WETH_ABI from "../../common/abi/Weth.json";

const BINANCE_API = "https://api.binance.com";

export class BinanceCEXBridge extends BaseBridgeAdapter {
  private readonly apiKey: string;
  private readonly secretKey: string;
  private readonly bridgeToken: Contract;
  private readonly tokenSymbol: string;
  private readonly tokenDecimals: number;
  private readonly network: string;

  constructor(
    l2chainId: number,
    hubChainId: number,
    l1Signer: Signer,
    l2SignerOrProvider: Signer | Provider,
    l1Token: EvmAddress
  ) {
    // No L1 gateways needed since no L1 bridge transfers tokens from the EOA.
    super(l2chainId, hubChainId, l1Signer, l2SignerOrProvider, []);
    // Pull the binance API key from environment and throw if we cannot instantiate this bridge.
    this.apiKey = process.env["BINANCE_API_KEY"];
    this.secretKey = process.env["BINANCE_SECRET_KEY"];
    assert(isDefined(this.apiKey) && isDefined(this.secretKey), "Binance CEX bridge missing key configuration");

    // Pass in the WETH ABI as the ERC20 ABI. This is fine to do since we only call `transfer` on `this.l1Bridge`.
    this.l1Bridge = new Contract(l1Token.toAddress(), WETH_ABI, l1Signer);

    // Get the required token/network context needed to query the Binance API.
    this.tokenSymbol = getTokenInfo(l1Token.toAddress(), this.hubChainId).symbol;
    this.network = chainIsProd(l2chainId) ? "ETH" : "SEP";
  }

  async constructL1ToL2Txn(
    _toAddress: EvmAddress,
    l1Token: EvmAddress,
    _l2Token: EvmAddress,
    amount: BigNumber
  ): Promise<BridgeTransactionDetails> {
    assert(l1Token.toAddress() === this.bridgeToken.address);
    // Fetch the deposit address from the binance API.
    const requestParams = {
      coin: this.tokenSymbol,
      network: this.network,
      timestamp: Date.now(),
    };
    const depositAddressResult = await this._queryBinanceApi("/sapi/v1/capital/deposit/address", requestParams);
    // Once we have the address, create a `transfer` of the token to that address.
    return {
      method: "transfer",
      args: [depositAddressResult["address"], amount],
      contract: this.getL1Bridge(),
    };
  }

  async queryL1BridgeInitiationEvents(
    l1Token: EvmAddress,
    _fromAddress: EvmAddress,
    _toAddress: EvmAddress,
    eventConfig: EventSearchConfig
  ): Promise<BridgeEvents> {
    assert(l1Token.toAddress() === this.bridgeToken.address);
    const fromTimestamp = (await getTimestampForBlock(this.getL1Bridge().provider, eventConfig.fromBlock)) * 1_000; // Convert timestamp to ms.

    // Fetch the deposit address from the binance API.
    const requestParams = {
      coin: this.tokenSymbol,
      network: this.network,
      startTime: fromTimestamp,
      timestamp: Date.now(),
    };
    const depositHistory = await this._queryBinanceApi("/sapi/v1/capital/deposit/hisrec", requestParams);
    const depositTxReceipts = await mapAsync(
      depositHistory.map((deposit) => deposit.txId as string),
      async (transactionHash) => this.getL1Bridge().provider.getTransactionReceipt(transactionHash)
    );

    return {
      [this.resolveL2TokenAddress(l1Token)]: depositHistory.map((deposit, idx) => {
        const strAmount = deposit.amount as string;
        const decimalIdx = strAmount.indexOf(".");
        const bnAmount = toBN(strAmount.replace(/./g, ""));
        const { decimals: l1Decimals } = getTokenInfo(l1Token.toAddress(), this.hubChainId);
        return {
          amount: ConvertDecimals(strAmount.length - decimalIdx, l1Decimals)(bnAmount),
          txnRef: depositTxReceipts[idx].transactionHash,
          txnIndex: depositTxReceipts[idx].transactionIndex,
          // Only query the first log in the deposit event since a deposit corresponds to a single ERC20 `Transfer` event.
          logIndex: depositTxReceipts[idx].logs[0].logIndex,
          blockNumber: depositTxReceipts[idx].blockNumber,
        };
      }),
    };
  }

  async queryL2BridgeFinalizationEvents(
    l1Token: EvmAddress,
    _fromAddress: EvmAddress,
    __toAddress: EvmAddress,
    eventConfig: EventSearchConfig
  ): Promise<BridgeEvents> {
    assert(l1Token.toAddress() === this.bridgeToken.address);
    // We must typecast the l2 signer or provider into specifically an ethers Provider type so we can call `getTransactionReceipt` on it.
    const l2Provider =
      this.l2SignerOrProvider instanceof ethers.providers.Provider
        ? (this.l2SignerOrProvider as ethers.providers.Provider)
        : (this.l2SignerOrProvider as ethers.Signer).provider;
    const fromTimestamp = (await getTimestampForBlock(this.getL1Bridge().provider, eventConfig.fromBlock)) * 1_000; // Convert timestamp to ms.

    // Fetch the deposit address from the binance API.
    const requestParams = {
      coin: this.tokenSymbol,
      network: this.network,
      startTime: fromTimestamp,
      timestamp: Date.now(),
    };
    const withdrawalHistory = await this._queryBinanceApi("/sapi/v1/capital/withdraw/history", requestParams);
    const withdrawalTxReceipts = await mapAsync(
      withdrawalHistory.map((withdrawal) => withdrawal.txId as string),
      async (transactionHash) => l2Provider.getTransactionReceipt(transactionHash)
    );

    return {
      [this.resolveL2TokenAddress(l1Token)]: withdrawalHistory.map((withdrawal, idx) => {
        const strAmount = withdrawal.amount as string;
        const decimalIdx = strAmount.indexOf(".");
        const bnAmount = toBN(strAmount.replace(/./g, ""));
        // We should return the amount in terms of L1 token decimals.
        const { decimals: l1Decimals } = getTokenInfo(l1Token.toAddress(), this.hubChainId);
        return {
          amount: ConvertDecimals(strAmount.length - decimalIdx, l1Decimals)(bnAmount),
          txnRef: withdrawalTxReceipts[idx].transactionHash,
          txnIndex: withdrawalTxReceipts[idx].transactionIndex,
          // Same as resolving initiation events. Only query the first log since it is just an ERC20 `Transfer` call.
          logIndex: withdrawalTxReceipts[idx].logs[0].logIndex,
          blockNumber: withdrawalTxReceipts[idx].blockNumber,
        };
      }),
    };
  }

  protected async _queryBinanceApi(
    requestPath: string,
    requestParams: Record<string, unknown>
  ): Promise<Record<string, unknown>[]> {
    const queryString = Object.entries(requestParams)
      .map(([key, val]) => `${key}=${val}`)
      .join("&");
    const signature = hmac(queryString, this.secretKey);
    return axios.get(`${BINANCE_API}${requestPath}`, {
      params: {
        ...requestParams,
        signature,
      },
      headers: {
        "X-MBX-APIKEY": this.apiKey,
      },
    });
  }
}
