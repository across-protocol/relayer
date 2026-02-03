import { utils as ethersUtils } from "ethers";
import { BigNumber, EvmAddress, isDefined } from "./";

export type PolymarketIntentV1 = {
  version: number;
  recipient: EvmAddress;
  solver: EvmAddress;
  outcomeToken: EvmAddress;
  tokenId: BigNumber;
  outcomeAmount: BigNumber;
  limitPrice: BigNumber;
  clientOrderId: string;
};

const POLYMARKET_INTENT_TUPLE =
  "tuple(uint8 version,address recipient,address solver,address outcomeToken,uint256 tokenId,uint256 outcomeAmount,uint256 limitPrice,bytes32 clientOrderId)";

export function decodePolymarketIntent(message?: string): PolymarketIntentV1 | undefined {
  if (!isDefined(message) || message === "0x") {
    return;
  }
  try {
    const [decoded] = ethersUtils.defaultAbiCoder.decode([POLYMARKET_INTENT_TUPLE], message) as [
      {
        version: number;
        recipient: string;
        solver: string;
        outcomeToken: string;
        tokenId: BigNumber;
        outcomeAmount: BigNumber;
        limitPrice: BigNumber;
        clientOrderId: string;
      }
    ];

    if (Number(decoded.version) !== 1) {
      return;
    }

    return {
      version: Number(decoded.version),
      recipient: EvmAddress.from(decoded.recipient),
      solver: EvmAddress.from(decoded.solver),
      outcomeToken: EvmAddress.from(decoded.outcomeToken),
      tokenId: BigNumber.from(decoded.tokenId),
      outcomeAmount: BigNumber.from(decoded.outcomeAmount),
      limitPrice: BigNumber.from(decoded.limitPrice),
      clientOrderId: decoded.clientOrderId,
    };
  } catch {
    return;
  }
}
