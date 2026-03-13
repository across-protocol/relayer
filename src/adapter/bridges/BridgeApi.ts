import { Contract, Signer } from "ethers";
import { BridgeTransactionDetails, BaseBridgeAdapter, BridgeEvents } from "./BaseBridgeAdapter";
import {
  BigNumber,
  EventSearchConfig,
  Provider,
  assert,
  Address,
  EvmAddress,
  winston,
  toBN,
  getNetworkName,
  CHAIN_IDs,
  TOKEN_SYMBOLS_MAP,
  paginatedEventQuery,
  ZERO_ADDRESS,
} from "../../utils";
import { TransferTokenParams, processEvent } from "../utils";
import ERC20_ABI from "../../common/abi/MinimalERC20.json";
import axios from "axios";

export const BRIDGE_API_MINIMUMS: { [l2ChainId: number]: BigNumber } = {
  [CHAIN_IDs.MAINNET]: toBN(1_000_000), // 1 USDC
  [CHAIN_IDs.TEMPO]: toBN(1_000_000), // 1 USDC
};

// We need to instruct this bridge what tokens we expect to receive on L2, since the bridge
// API supports multiple destination tokens for a single L1 token.
const BRIDGE_API_DESTINATION_TOKENS: { [l2ChainId: number]: string } = {
  [CHAIN_IDs.TEMPO]: TOKEN_SYMBOLS_MAP.pathUSD.addresses[CHAIN_IDs.TEMPO],
};

export class BridgeApi extends BaseBridgeAdapter {
  protected bridgeApiBase: string;
  protected bridgeApiKey: string;
  protected customerId: string;

  constructor(
    l2chainId: number,
    hubChainId: number,
    l1Signer: Signer,
    l2SignerOrProvider: Signer | Provider,
    l1Token: EvmAddress,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _logger: winston.Logger
  ) {
    // Bridge API is only valid on mainnet.
    assert(hubChainId === CHAIN_IDs.MAINNET);

    super(l2chainId, hubChainId, l1Signer, []);
    this.l1Bridge = new Contract(l1Token.toNative(), ERC20_ABI, l1Signer);
    this.l2Bridge = new Contract(BRIDGE_API_DESTINATION_TOKENS[this.l2chainId], ERC20_ABI, l2SignerOrProvider);

    // We need to fetch some API configuration details from environment.
    const { BRIDGE_API_BASE, BRIDGE_API_KEY, BRIDGE_CUSTOMER_ID } = process.env;
    this.bridgeApiBase = String(BRIDGE_API_BASE);
    this.bridgeApiKey = String(BRIDGE_API_KEY);
    this.customerId = String(BRIDGE_CUSTOMER_ID);
  }

  async constructL1ToL2Txn(
    toAddress: Address,
    l1Token: EvmAddress,
    l2Token: Address,
    amount: BigNumber,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _optionalParams?: TransferTokenParams
  ): Promise<BridgeTransactionDetails> {
    assert(
      this.getL2Bridge().address === l2Token.toNative(),
      `Attempting to bridge unsupported l2 token ${l2Token.toNative()}`
    );
    // If amount is less than the network minimums, then throw.
    if (amount.lt(BRIDGE_API_MINIMUMS[this.l2chainId])) {
      throw new Error(`Cannot bridge to ${getNetworkName(this.l2chainId)} due to invalid amount ${amount}`);
    }
    const transferRouteAddress = await this.getTransferRouteEscrowAddress(toAddress);
    return Promise.resolve({
      contract: this.getL1Bridge(),
      method: "transfer",
      args: [transferRouteAddress, amount],
    });
  }

  async queryL1BridgeInitiationEvents(
    l1Token: EvmAddress,
    fromAddress: EvmAddress,
    toAddress: Address,
    eventConfig: EventSearchConfig
  ): Promise<BridgeEvents> {
    const expectedRecipientAddress = await this.getTransferRouteEscrowAddress(toAddress);
    const l1TransferEvents = await paginatedEventQuery(
      this.getL1Bridge(),
      this.getL1Bridge().filters.Transfer(fromAddress.toNative(), expectedRecipientAddress),
      eventConfig
    );
    return {
      [this.getL2Bridge().address]: l1TransferEvents.map((e) => processEvent(e, "value")),
    };
  }

  async queryL2BridgeFinalizationEvents(
    _l1Token: EvmAddress,
    _fromAddress: EvmAddress,
    toAddress: Address,
    eventConfig: EventSearchConfig
  ): Promise<BridgeEvents> {
    // @todo: Is the destination token "minted?"
    const l2TransferEvents = await paginatedEventQuery(
      this.getL2Bridge(),
      this.getL2Bridge().filters.Transfer(ZERO_ADDRESS, toAddress.toNative()),
      eventConfig
    );
    return {
      [this.getL2Bridge().address]: l2TransferEvents.map((e) => processEvent(e, "value")),
    };
  }

  async getTransferRouteEscrowAddress(toAddress: Address): Promise<string> {
    // @todo based on the structure of data returned by the bridge API.
    // should we make a new address on each transfer or reuse the same address?
    await this._createTransferRouteEscrowAddress(toAddress);
    return toAddress.toNative();
  }

  async _createTransferRouteEscrowAddress(toAddress: Address) {
    const idempotencyKey = String(Date.now()); // @todo
    const headers = {
      "Api-Key": `${this.bridgeApiKey}`,
      "Idempotency-Key": idempotencyKey,
      "Content-Type": "application/json",
    };
    const data = {
      on_behalf_of: `${this.customerId}`,
      source: {
        payment_rail: "ethereum",
        currency: "usdc",
      },
      destination: {
        payment_rail: "tempo", // @todo
        currency: "usdc", // @todo
        to_address: toAddress.toNative(),
      },
      return_instructions: {
        address: toAddress.toNative(),
      },
      features: {
        allow_any_from_address: true,
        flexible_amount: true,
      },
    };
    const { data: transferRequest } = await axios.post(`${this.bridgeApiBase}/v0/transfers`, data, { headers });
    // @todo Extract the source address.
  }
}
