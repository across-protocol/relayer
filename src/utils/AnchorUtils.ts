import { getNodeUrlList, CHAIN_IDs } from "./";
import { AnchorProvider, Program, Idl, web3, Wallet } from "@coral-xyz/anchor";

export function getAnchorProgram(idl: Idl): Program {
  const provider = getAnchorProvider();
  return new Program(idl, provider);
}

export function getAnchorProvider(): AnchorProvider {
  const nodeUrlList = getNodeUrlList(CHAIN_IDs.SOLANA);
  return new AnchorProvider(new web3.Connection(Object.values(nodeUrlList)[0]), {
    publicKey: new web3.PublicKey("CCTPmbSD7gX1bxKPAmg77w8oFzNFpaQiQUWD43TKaecd"),
  } as unknown as Wallet);
}
