import { CONTRACT_ADDRESSES } from "../../common";
import { Contract, TOKEN_SYMBOLS_MAP, compareAddressesSimple } from "../../utils";
import { BaseAdapter } from "./BaseAdapter";

/**
 * An extension of the BaseAdapter class that is meant to be an intermediary
 * between adapters and the BaseAdapter class. Holds additional functions meant
 * to be used to bridge USDC via CCTP.
 */
export abstract class CCTPAdapter extends BaseAdapter {
  /**
   * Check if a token is USDC - this is a requirement to be transferred via CCTP
   * @param l1Token A Web3 address of a token
   * @returns Whether or not this token is USDC on Mainnet
   */
  isL1TokenUsdc(l1Token: string): boolean {
    return compareAddressesSimple(l1Token, TOKEN_SYMBOLS_MAP.USDC.addresses[this.hubChainId]);
  }

  /**
   * Get the CCTP token messenger bridge contract. Used to interface with the CCTP bridge.
   * @returns The CCTP token messenger bridge contract on the hub chain
   */
  getL1CCTPTokenMessengerBridge(): Contract {
    const { hubChainId } = this;
    return new Contract(
      CONTRACT_ADDRESSES[hubChainId].cctpTokenMessenger.address,
      CONTRACT_ADDRESSES[hubChainId].cctpTokenMessenger.abi,
      this.getSigner(hubChainId)
    );
  }
}
