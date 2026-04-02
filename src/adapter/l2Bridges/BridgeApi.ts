import {
  Address,
  BigNumber,
  bnZero,
  Contract,
  EventSearchConfig,
  getNetworkName,
  Signer,
  EvmAddress,
  CHAIN_IDs,
  BRIDGE_API_MINIMUMS,
  toBN,
  BridgeApiClient,
  getTokenInfo,
  floatToBN,
  isDefined,
  assert,
  BRIDGE_API_DESTINATION_TOKEN_SYMBOLS,
  getTimestampForBlock,
  toAddressType,
  BRIDGE_API_DESTINATION_TOKENS,
  createFormatFunction,
  roundAmountToSend,
} from "../../utils";
import { BaseL2BridgeAdapter } from "./BaseL2BridgeAdapter";
import { AugmentedTransaction } from "../../clients/TransactionClient";
import { TokenInfo } from "../../interfaces";
import ERC20_ABI from "../../common/abi/MinimalERC20.json";

export class BridgeApi extends BaseL2BridgeAdapter {
  protected api: BridgeApiClient;
  protected l1TokenInfo: TokenInfo;
  protected l2TokenInfo: TokenInfo;

  constructor(l2chainId: number, hubChainId: number, l2Signer: Signer, l1Signer: Signer, l1Token: EvmAddress) {
    if (hubChainId !== CHAIN_IDs.MAINNET) {
      throw new Error("Cannot define a Bridge API bridge for a non-production network");
    }
    super(l2chainId, hubChainId, l2Signer, l1Signer, l1Token);

    // We need to fetch some API configuration details from environment.
    const { BRIDGE_API_BASE = "https://api.bridge.xyz", BRIDGE_API_KEY, BRIDGE_CUSTOMER_ID } = process.env;

    assert(isDefined(BRIDGE_API_BASE), "BRIDGE_API_BASE must be set in the environment");
    assert(isDefined(BRIDGE_API_KEY), "BRIDGE_API_KEY must be set in the environment");
    assert(isDefined(BRIDGE_CUSTOMER_ID), "BRIDGE_CUSTOMER_ID must be set in the environment");

    this.api = new BridgeApiClient(
      BRIDGE_API_BASE,
      BRIDGE_API_KEY,
      BRIDGE_CUSTOMER_ID,
      this.l2chainId,
      this.hubChainId
    );

    this.l1TokenInfo = getTokenInfo(l1Token, this.hubChainId);
    this.l2TokenInfo = getTokenInfo(
      toAddressType(BRIDGE_API_DESTINATION_TOKENS[this.l2chainId], this.l2chainId),
      this.l2chainId
    );
  }

  override getL2Token(): Address {
    return toAddressType(BRIDGE_API_DESTINATION_TOKENS[this.l2chainId], this.l2chainId);
  }

  async constructWithdrawToL1Txns(
    toAddress: EvmAddress,
    l2Token: EvmAddress,
    l1Token: EvmAddress,
    _amount: BigNumber
  ): Promise<AugmentedTransaction[]> {
    const amount = roundAmountToSend(_amount, this.l2TokenInfo.decimals, 2);
    // If amount is less than the network minimums, then throw.
    if (amount.lt(BRIDGE_API_MINIMUMS[this.l2chainId]?.[this.hubChainId] ?? toBN(Number.MAX_SAFE_INTEGER))) {
      throw new Error(`Cannot bridge to ${getNetworkName(this.hubChainId)} due to invalid amount ${amount}`);
    }
    const formatter = createFormatFunction(2, 4, false, this.l2TokenInfo.decimals);
    const l2TokenSymbol = BRIDGE_API_DESTINATION_TOKEN_SYMBOLS[l2Token.toNative()];
    const transferRouteSource = await this.api.createTransferRouteEscrowAddress(
      toAddress,
      l2TokenSymbol,
      this.l1TokenInfo.symbol,
      formatter(amount)
    );
    const l2TokenContract = new Contract(l2Token.toNative(), ERC20_ABI, this.l2Signer);
    const transferTxn = {
      contract: l2TokenContract,
      method: "transfer",
      chainId: this.l2chainId,
      args: [transferRouteSource, amount],
      nonMulticall: true,
      canFailInSimulation: false,
      value: bnZero,
      message: `🎰 Withdrew ${getNetworkName(this.l2chainId)} ${this.l2TokenInfo.symbol} to L1`,
      mrkdwn: `Withdrew ${formatter(amount.toString())} ${this.l2TokenInfo.symbol} from ${getNetworkName(
        this.l2chainId
      )} to L1`,
    };
    return [transferTxn];
  }

  // @dev We do not filter on origin/destination tokens since there is only one bridge API destination token for any destination chain.
  // e.g. For Tempo, we only use Bridge for pathUSD; other tokens are rebalanced via other methods, so
  // if there is an outstanding transfer from Tempo to Ethereum, then this must be a pathUSD transfer.
  async getL2PendingWithdrawalAmount(
    l2EventConfig: EventSearchConfig,
    l1EventConfig: EventSearchConfig,
    fromAddress: EvmAddress,
    l2Token: EvmAddress
  ): Promise<BigNumber> {
    const fromTimestamp = await getTimestampForBlock(this.l1Signer.provider, l1EventConfig.from);
    const allTransfers = await this.api.getAllTransfersInRange(fromAddress, fromTimestamp * 1000);

    const allInitiatedTransfers = await this.api.filterInitiatedTransfers(
      allTransfers,
      fromAddress,
      l2EventConfig,
      this.l2Signer.provider
    );
    return allInitiatedTransfers.reduce((acc, transfer) => {
      const { decimals: l2TokenDecimals } = getTokenInfo(l2Token, this.l2chainId);
      return acc.add(floatToBN(transfer.receipt?.final_amount ?? transfer.amount, l2TokenDecimals));
    }, bnZero);
  }
}
