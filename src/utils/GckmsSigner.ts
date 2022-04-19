import { ManagedSecretProvider, getWeb3ByChainId } from "@uma/common";
import { getGckmsConfig } from "./GckmsConfig";

import { ethers } from "ethers";
import { Logger } from "@ethersproject/logger";
import { BigNumber, BigNumberish } from "@ethersproject/bignumber";
import { Deferrable, defineReadOnly, resolveProperties, shallowCopy } from "@ethersproject/properties";
import { BlockTag, FeeData, Provider, TransactionRequest, TransactionResponse } from "@ethersproject/abstract-provider";
import { Bytes, BytesLike } from "@ethersproject/bytes";

const logger = new Logger("1");

export interface TypedDataDomain {
  name?: string;
  version?: string;
  chainId?: BigNumberish;
  verifyingContract?: string;
  salt?: BytesLike;
}

export interface TypedDataField {
  name: string;
  type: string;
}

interface TypedDataSigner {
  _signTypedData(
    domain: TypedDataDomain,
    types: Record<string, Array<TypedDataField>>,
    value: Record<string, any>
  ): Promise<string>;
}

export class GckmsSigner extends ethers.Signer implements TypedDataSigner {
  readonly address: string;

  readonly web3GckmsProvider: any;

  constructor(address: string) {
    logger.checkNew(new.target, ethers.VoidSigner);
    super();
    defineReadOnly(this, "address", address);

    // const web3 = getWeb3ByChainId(getGckmsConfig().networkId);

    const gckmsConfig = getGckmsConfig();
    this.web3GckmsProvider = new ManagedSecretProvider(gckmsConfig, null, 0, gckmsConfig.length);
  }

  getAddress(): Promise<string> {
    return Promise.resolve(this.web3GckmsProvider.getAccounts())[0];
  }

  _fail(message: string, operation: string): Promise<any> {
    return Promise.resolve().then(() => {
      logger.throwError(message, Logger.errors.UNSUPPORTED_OPERATION, { operation: operation });
    });
  }

  signMessage(message: Bytes | string): Promise<string> {
    return this._fail("VoidSigner cannot sign messages", "signMessage");
  }

  signTransaction(transaction: Deferrable<TransactionRequest>): Promise<string> {
    return this._fail("VoidSigner cannot sign transactions", "signTransaction");
  }

  _signTypedData(
    domain: TypedDataDomain,
    types: Record<string, Array<TypedDataField>>,
    value: Record<string, any>
  ): Promise<string> {
    return this._fail("VoidSigner cannot sign typed data", "signTypedData");
  }

  connect(provider: Provider): ethers.VoidSigner {
    return new ethers.VoidSigner(this.address, provider);
  }
}
