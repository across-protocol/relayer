import { Signer, isSignerWallet, assert } from "./";
import * as hl from "@nktkas/hyperliquid";

export function getDefaultHlTransport(extraOptions: ConstructorParameters<typeof hl.HttpTransport> = []) {
  return new hl.HttpTransport(...extraOptions);
}

export function getHlExchangeClient(
  signer: Signer,
  transport: hl.HttpTransport | hl.WebSocketTransport = getDefaultHlTransport()
) {
  assert(
    isSignerWallet(signer),
    "HyperliquidUtils#getHlExchangeClient: Cannot define an exchange client without a wallet."
  );
  return new hl.ExchangeClient({ wallet: signer, transport });
}

export function getHlInfoClient(transport: hl.HttpTransport | hl.WebSocketTransport = getDefaultHlTransport()) {
  return new hl.InfoClient({ transport });
}
