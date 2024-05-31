import { CONTRACT_ADDRESSES, chainIdsToCctpDomains } from "../../common";
import { SortableEvent } from "../../interfaces";
import {
  BigNumber,
  Contract,
  TOKEN_SYMBOLS_MAP,
  TransactionResponse,
  assert,
  bnZero,
  compareAddressesSimple,
  spreadEventWithBlockNumber,
} from "../../utils";
import {
  cctpAddressToBytes32,
  cctpBytes32ToAddress,
  retrieveOutstandingCCTPBridgeUSDCTransfers,
} from "../../utils/CCTPUtils";
import { BaseAdapter } from "./BaseAdapter";

/**
 * An extension of the BaseAdapter class that is meant to be an intermediary
 * between adapters and the BaseAdapter class. Holds additional functions meant
 * to be used to bridge USDC via CCTP.
 */
export abstract class CCTPAdapter extends BaseAdapter {
  /**
   * Get the CCTP domain of the target chain. This is used to determine the destination
   * domain of a CCTP message.
   * @returns The CCTP domain of the target chain
   */
  private get l2DestinationDomain(): number {
    return chainIdsToCctpDomains[this.chainId];
  }

  /**
   * Check if an L1 token is USDC - this is a requirement to be transferred via CCTP
   * @param l1Token A Web3 address of a token
   * @returns Whether or not this token is USDC on Mainnet
   */
  protected isL1TokenUsdc(l1Token: string): boolean {
    return compareAddressesSimple(l1Token, TOKEN_SYMBOLS_MAP.USDC.addresses[this.hubChainId]);
  }

  /**
   * Check if an L2 token is USDC - this is a requirement to be transferred via CCTP
   * @param l2Token A Web3 address of a token
   * @returns Whether or not this token is USDC on the target chain
   */
  protected isL2TokenUsdc(l2Token: string): boolean {
    return compareAddressesSimple(l2Token, TOKEN_SYMBOLS_MAP.USDC.addresses[this.chainId]);
  }

  /**
   * Get the CCTP token messenger bridge contract. Used to interface with the CCTP bridge.
   * @returns The CCTP token messenger bridge contract on the hub chain
   */
  protected getL1CCTPTokenMessengerBridge(): Contract {
    const { hubChainId } = this;
    return new Contract(
      CONTRACT_ADDRESSES[hubChainId].cctpTokenMessenger.address,
      CONTRACT_ADDRESSES[hubChainId].cctpTokenMessenger.abi,
      this.getSigner(hubChainId)
    );
  }

  protected getL2CCTPTokenMessengerBridge(): Contract {
    return new Contract(
      CONTRACT_ADDRESSES[this.chainId].cctpTokenMessenger.address,
      CONTRACT_ADDRESSES[this.chainId].cctpTokenMessenger.abi,
      this.getSigner(this.chainId)
    );
  }

  protected getL2CCTPMessageTransmitter(): Contract {
    return new Contract(
      CONTRACT_ADDRESSES[this.chainId].cctpMessageTransmitter.address,
      CONTRACT_ADDRESSES[this.chainId].cctpMessageTransmitter.abi,
      this.getSigner(this.chainId)
    );
  }

  /**
   * Retrieves the outstanding transfers for USDC from the hub chain to
   * the destination chain.
   * @param address The address to check for outstanding transfers
   * @returns The outstanding transfers for the given address
   */
  protected async getOutstandingCctpTransfers(address: string): Promise<SortableEvent[]> {
    const { l1SearchConfig } = await this.getUpdatedSearchConfigs();
    if (l1SearchConfig.fromBlock >= l1SearchConfig.toBlock) {
      // This should return the set of in-flight events, but they aren't available within the adapter. @todo: Fix!
      return [];
    }

    const l1TokenMessenger = this.getL1CCTPTokenMessengerBridge();
    const l2MessageTransmitter = this.getL2CCTPMessageTransmitter();

    const events = await retrieveOutstandingCCTPBridgeUSDCTransfers(
      l1TokenMessenger,
      l2MessageTransmitter,
      l1SearchConfig,
      TOKEN_SYMBOLS_MAP.USDC.addresses[this.hubChainId],
      this.hubChainId,
      this.chainId,
      address
    );

    this.baseL1SearchConfig.fromBlock = l1SearchConfig.toBlock + 1;

    return events.map((event) => ({
      ...spreadEventWithBlockNumber(event),
      to: cctpBytes32ToAddress(event.args.mintRecipient),
    }));
  }

  /**
   * A helper function to send USDC via CCTP to the target chain
   * @param address The recipient address on the target chain
   * @param l1Token The token on the hub chain - must be USDC
   * @param l2Token The token on the target chain - must be USDC
   * @param amount The amount of funds to send via CCTP
   * @param simMode Whether or not to simulate the transaction
   * @returns The transaction response of the CCTP message
   */
  protected sendCctpTokenToTargetChain(
    address: string,
    l1Token: string,
    l2Token: string,
    amount: BigNumber,
    simMode: boolean
  ): Promise<TransactionResponse> {
    // Sanity check to ensure that the token is USDC as this is the only token
    // configured to be bridged via CCTP
    assert(this.isL1TokenUsdc(l1Token), "Token must be native USDC from the hub chain");
    assert(this.isL2TokenUsdc(l2Token), "Token must be native USDC on the target chain");

    const l1Bridge = this.getL1CCTPTokenMessengerBridge();
    const l1BridgeMethod = "depositForBurn";
    const l1BridgeArgs = [amount, this.l2DestinationDomain, cctpAddressToBytes32(address), l1Token];
    return this._sendTokenToTargetChain(
      l1Token,
      l2Token,
      amount,
      l1Bridge,
      l1BridgeMethod,
      l1BridgeArgs,
      2, // Gas multiplier
      bnZero,
      simMode
    );
  }
}
