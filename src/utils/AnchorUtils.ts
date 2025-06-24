import {
  getNodeUrlList,
  CHAIN_IDs,
  DEFAULT_SIMULATED_RELAYER_ADDRESS_SVM,
  isDefined,
  getSvmSignerFromEvmSigner,
  Signer,
} from "./";
import { AnchorProvider, Program, Idl, web3, Wallet as SolanaWallet } from "@coral-xyz/anchor";

export async function getAnchorProgram(idl: Idl, signer?: Signer): Promise<Program> {
  const wallet = isDefined(signer)
    ? new SolanaWallet(getSvmSignerFromEvmSigner(signer))
    : (AnchorVoidSigner(new web3.PublicKey(DEFAULT_SIMULATED_RELAYER_ADDRESS_SVM)) as SolanaWallet);
  const provider = getAnchorProvider(wallet);
  return new Program(idl, provider);
}

export async function getTypedAnchorProgram<P extends Idl>(
  idl: P,
  signer?: Signer,
  overrideProgramId?: string
): Promise<Program<P>> {
  const wallet = isDefined(signer)
    ? new SolanaWallet(await getSvmSignerFromEvmSigner(signer))
    : (AnchorVoidSigner(new web3.PublicKey(DEFAULT_SIMULATED_RELAYER_ADDRESS_SVM)) as SolanaWallet);
  const provider = getAnchorProvider(wallet);
  if (overrideProgramId) {
    // TODO: is this OK?
    idl.address = overrideProgramId;
  }
  return new Program<P>(idl, provider);
}

export function getAnchorProvider(wallet: SolanaWallet): AnchorProvider {
  const nodeUrlList = getNodeUrlList(CHAIN_IDs.SOLANA);
  return new AnchorProvider(new web3.Connection(Object.values(nodeUrlList)[0]), wallet);
}

export function toPublicKey(pubkey: string): web3.PublicKey {
  return new web3.PublicKey(pubkey);
}

const AnchorVoidSigner = (publicKey: web3.PublicKey) => {
  return {
    publicKey,
    signTransaction: async (_tx: web3.Transaction): Promise<web3.Transaction> => {
      _tx;
      throw new Error("Cannot sign transaction with a void signer");
    },
    signAllTransactions: async (_txs: web3.Transaction[]): Promise<web3.Transaction[]> => {
      _txs;
      throw new Error("Cannot sign transactions with a void signer");
    },
  };
};
