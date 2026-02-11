import { ethers } from "ethers";
import {
  createKeyPairSignerFromBytes,
  createDefaultRpcTransport,
  createSolanaRpcFromTransport,
  KeyPairSigner,
  address,
  getProgramDerivedAddress,
  appendTransactionMessageInstruction,
  pipe,
  type Address as KitAddress,
  AccountRole,
  type AccountMeta,
} from "@solana/kit";
import {
  winston,
  SvmAddress,
  sendAndConfirmSolanaTransaction,
  simulateSolanaTransaction,
  SVMProvider,
  TOKEN_SYMBOLS_MAP,
  getAssociatedTokenAddress,
} from "../../utils";
import { PublicKey } from "@solana/web3.js";
import { MessageTransmitterV2Client, TokenMessengerMinterV2Client } from "@across-protocol/contracts";
import * as sdk from "@across-protocol/sdk";
import { DestinationUsdcNotConfiguredError, OriginUsdcNotConfiguredError } from "../errors";
import {
  MESSAGE_TRANSMITTER_V2_PROGRAM,
  MINT_RECIPIENT_LENGTH,
  MINT_RECIPIENT_OFFSET,
  NONCE_LENGTH,
  NONCE_OFFSET,
  TOKEN_2022_PROGRAM,
  TOKEN_MESSENGER_V2_PROGRAM,
} from "./svmConstants";

const textEncoder = new TextEncoder();

type SolanaAddress = KitAddress<string>;

type ParsedCctpV2Message = {
  buffer: Buffer;
  mintRecipientBytes32: Uint8Array;
  nonceSeed: Uint8Array;
};

type MessageTransmitterAccounts = {
  messageTransmitterAccount: SolanaAddress;
  usedNonce: SolanaAddress;
  authorityPda: SolanaAddress;
};

type TokenMessengerAccounts = {
  tokenMessengerAccount: SolanaAddress;
  tokenMinterAccount: SolanaAddress;
  localToken: SolanaAddress;
  remoteTokenMessengerKey: SolanaAddress;
  tokenPair: SolanaAddress;
  feeRecipientAddr: SolanaAddress;
  feeRecipientTokenAccount: SolanaAddress;
  recipientTokenAccount: SolanaAddress;
  custodyTokenAccount: SolanaAddress;
  tokenMessengerEventAuthority: SolanaAddress;
  solanaUsdcAddr: SolanaAddress;
};

function parseCctpV2Message(message: string): ParsedCctpV2Message {
  const normalized = message.startsWith("0x") ? message.slice(2) : message;
  const buffer = Buffer.from(normalized, "hex");
  const mintRecipientBytes32 = buffer.slice(MINT_RECIPIENT_OFFSET, MINT_RECIPIENT_OFFSET + MINT_RECIPIENT_LENGTH);
  const nonceSeed = buffer.slice(NONCE_OFFSET, NONCE_OFFSET + NONCE_LENGTH);

  return {
    buffer,
    mintRecipientBytes32: new Uint8Array(mintRecipientBytes32),
    nonceSeed: new Uint8Array(nonceSeed),
  };
}

function hexStringToBytes(value: string): Uint8Array {
  return new Uint8Array(Buffer.from(value.replace(/^0x/, ""), "hex"));
}

async function getMessageTransmitterAccounts(nonceSeed: Uint8Array): Promise<MessageTransmitterAccounts> {
  const [messageTransmitterAccount] = await getProgramDerivedAddress({
    seeds: [textEncoder.encode("message_transmitter")],
    programAddress: MESSAGE_TRANSMITTER_V2_PROGRAM,
  });

  const [usedNonce] = await getProgramDerivedAddress({
    seeds: [textEncoder.encode("used_nonce"), nonceSeed],
    programAddress: MESSAGE_TRANSMITTER_V2_PROGRAM,
  });

  const tokenMessengerProgramBytes = new PublicKey(TOKEN_MESSENGER_V2_PROGRAM.toString()).toBytes();
  const [authorityPda] = await getProgramDerivedAddress({
    seeds: [textEncoder.encode("message_transmitter_authority"), tokenMessengerProgramBytes],
    programAddress: MESSAGE_TRANSMITTER_V2_PROGRAM,
  });

  return { messageTransmitterAccount, usedNonce, authorityPda };
}

async function getTokenMessengerAccounts(
  provider: SVMProvider,
  destinationChainId: number,
  originChainId: number,
  mintRecipientBytes32: Uint8Array
): Promise<TokenMessengerAccounts> {
  const solanaUsdcAddress = TOKEN_SYMBOLS_MAP.USDC.addresses[destinationChainId];
  if (!solanaUsdcAddress) {
    throw new DestinationUsdcNotConfiguredError(destinationChainId);
  }

  const originUsdcAddress = TOKEN_SYMBOLS_MAP.USDC.addresses[originChainId];
  if (!originUsdcAddress) {
    throw new OriginUsdcNotConfiguredError(originChainId);
  }

  const solanaUsdcAddr = address(solanaUsdcAddress);
  const solanaUsdcBytes = new PublicKey(solanaUsdcAddr.toString()).toBytes();

  const remoteDomain = sdk.utils.getCctpDomainForChainId(originChainId);
  const remoteDomainBytes = textEncoder.encode(remoteDomain.toString());

  const depositAccounts = await sdk.arch.svm.getCCTPDepositAccounts(
    originChainId,
    remoteDomain,
    TOKEN_MESSENGER_V2_PROGRAM,
    MESSAGE_TRANSMITTER_V2_PROGRAM
  );

  const tokenMessengerAccount = depositAccounts.tokenMessenger;
  const tokenMinterAccount = depositAccounts.tokenMinter;
  const localToken = depositAccounts.localToken;
  const tokenMessengerEventAuthority = depositAccounts.cctpEventAuthority;
  const remoteTokenMessengerKey = depositAccounts.remoteTokenMessenger;

  const originUsdcBytes32 = new Uint8Array(32);
  const originUsdcBuffer = Buffer.from(originUsdcAddress.replace("0x", ""), "hex");
  originUsdcBytes32.set(new Uint8Array(originUsdcBuffer), 12);

  const [tokenPair] = await getProgramDerivedAddress({
    seeds: [textEncoder.encode("token_pair"), remoteDomainBytes, originUsdcBytes32],
    programAddress: TOKEN_MESSENGER_V2_PROGRAM,
  });

  const [custodyTokenAccount] = await getProgramDerivedAddress({
    seeds: [textEncoder.encode("custody"), solanaUsdcBytes],
    programAddress: TOKEN_MESSENGER_V2_PROGRAM,
  });

  const recipientTokenAccount = address(new PublicKey(mintRecipientBytes32).toBase58());

  const tokenMessengerData = await TokenMessengerMinterV2Client.fetchTokenMessenger(provider, tokenMessengerAccount);
  const feeRecipientAddr = tokenMessengerData.data.feeRecipient;

  const feeRecipientTokenAccount = await getAssociatedTokenAddress(
    SvmAddress.from(feeRecipientAddr.toString()),
    SvmAddress.from(solanaUsdcAddr.toString()),
    TOKEN_2022_PROGRAM
  );

  return {
    tokenMessengerAccount,
    tokenMinterAccount,
    localToken,
    remoteTokenMessengerKey,
    tokenPair,
    feeRecipientAddr,
    feeRecipientTokenAccount,
    recipientTokenAccount,
    custodyTokenAccount,
    tokenMessengerEventAuthority,
    solanaUsdcAddr,
  };
}

function buildHandleReceiveRemainingAccounts(accounts: TokenMessengerAccounts): AccountMeta<string>[] {
  return [
    { address: accounts.tokenMessengerAccount, role: AccountRole.READONLY },
    { address: accounts.remoteTokenMessengerKey, role: AccountRole.READONLY },
    { address: accounts.tokenMinterAccount, role: AccountRole.WRITABLE },
    { address: accounts.localToken, role: AccountRole.WRITABLE },
    { address: accounts.tokenPair, role: AccountRole.READONLY },
    { address: accounts.feeRecipientTokenAccount, role: AccountRole.WRITABLE },
    { address: accounts.recipientTokenAccount, role: AccountRole.WRITABLE },
    { address: accounts.custodyTokenAccount, role: AccountRole.WRITABLE },
    { address: TOKEN_2022_PROGRAM, role: AccountRole.READONLY },
    { address: accounts.tokenMessengerEventAuthority, role: AccountRole.READONLY },
    { address: TOKEN_MESSENGER_V2_PROGRAM, role: AccountRole.READONLY },
  ];
}

/**
 * Gets SVM provider from RPC URL
 */
export function getSvmProvider(rpcUrl: string): SVMProvider {
  const transport = createDefaultRpcTransport({ url: rpcUrl });
  return createSolanaRpcFromTransport(transport);
}

async function hasCCTPV2MessageBeenProcessed(message: string, provider: SVMProvider): Promise<boolean> {
  const parsedMessage = parseCctpV2Message(message);
  const { usedNonce } = await getMessageTransmitterAccounts(parsedMessage.nonceSeed);
  const nonceInfo = await provider.getAccountInfo(usedNonce).send();
  return Boolean(nonceInfo.value);
}

async function sendAndConfirmCCTPV2ReceiveMessageTx(params: {
  provider: SVMProvider;
  signer: KeyPairSigner;
  attestation: string;
  message: string;
  destinationChainId: number;
  originChainId: number;
  logger: winston.Logger;
}): Promise<string> {
  const { provider, signer, attestation, message, destinationChainId, originChainId, logger } = params;

  const parsedMessage = parseCctpV2Message(message);
  const [messageTransmitterAccounts, tokenMessengerAccounts] = await Promise.all([
    getMessageTransmitterAccounts(parsedMessage.nonceSeed),
    getTokenMessengerAccounts(provider, destinationChainId, originChainId, parsedMessage.mintRecipientBytes32),
  ]);

  const receiveInstruction = await MessageTransmitterV2Client.getReceiveMessageInstructionAsync({
    payer: signer,
    caller: signer,
    authorityPda: messageTransmitterAccounts.authorityPda,
    messageTransmitter: messageTransmitterAccounts.messageTransmitterAccount,
    usedNonce: messageTransmitterAccounts.usedNonce,
    receiver: TOKEN_MESSENGER_V2_PROGRAM,
    program: MESSAGE_TRANSMITTER_V2_PROGRAM,
    message: Uint8Array.from(parsedMessage.buffer),
    attestation: hexStringToBytes(attestation),
  });

  const instructionWithRemainingAccounts = {
    ...receiveInstruction,
    accounts: [...receiveInstruction.accounts, ...buildHandleReceiveRemainingAccounts(tokenMessengerAccounts)],
  };

  const tx = pipe(await sdk.arch.svm.createDefaultTransaction(provider, signer), (tx) =>
    appendTransactionMessageInstruction(instructionWithRemainingAccounts, tx)
  );

  // Simulate first and log full result on failure for easier debugging.
  try {
    const simResult = await simulateSolanaTransaction(tx, provider);
    const value = (simResult as { value?: { err?: unknown; logs?: string[] } })?.value;
    if (value?.err != null) {
      logger.error({
        at: "svmUtils#sendAndConfirmCCTPV2ReceiveMessageTx",
        message: "Solana transaction simulation failed; program logs and err below",
        destinationChainId,
        originChainId,
        simulationErr: value.err,
        simulationLogs: value.logs,
        simulationResultFull: simResult,
      });
    }
  } catch (simErr) {
    const err = simErr as Error & { value?: unknown };
    logger.error({
      at: "svmUtils#sendAndConfirmCCTPV2ReceiveMessageTx",
      message: "Solana simulation threw; details for debugging",
      destinationChainId,
      originChainId,
      simulationErrorMessage: err?.message,
      simulationErrorStack: err?.stack,
      simulationValue: err?.value,
    });
  }

  const signature = await sendAndConfirmSolanaTransaction(tx, provider);
  logger.info({
    at: "svmUtils#getCCTPV2ReceiveMessageTx",
    message: "Mint transaction completed on Solana V2",
    destinationChainId,
    originChainId,
    signature,
  });

  return signature;
}

/**
 * Checks if a CCTP message has already been processed on Solana
 * Detects message version and uses appropriate V1 or V2 function
 */
export async function checkIfAlreadyProcessedSvm(
  message: string,
  svmPrivateKey: Uint8Array,
  svmProvider: SVMProvider,
  logger: winston.Logger
): Promise<boolean> {
  const svmSigner = await createKeyPairSignerFromBytes(svmPrivateKey);
  const latestBlockhash = await svmProvider.getLatestBlockhash().send();

  const messageBytes = ethers.utils.arrayify(message);
  const messageBytesArray = ethers.utils.arrayify(messageBytes);

  const version = Number(ethers.utils.hexlify(messageBytesArray.slice(0, 4)));
  const sourceDomain = Number(ethers.utils.hexlify(messageBytesArray.slice(4, 8)));
  const nonce = Number(ethers.utils.hexlify(messageBytesArray.slice(12, 20)));

  logger.info({
    at: "svmUtils#checkIfAlreadyProcessedSvm",
    message: "Checking CCTP message version",
    version,
    sourceDomain,
    nonce,
  });

  // Version 0 = V1, Version 1 = V2
  if (version === 0) {
    return await sdk.arch.svm.hasCCTPV1MessageBeenProcessed(
      svmProvider,
      svmSigner,
      nonce,
      sourceDomain,
      latestBlockhash.value
    );
  } else {
    return await hasCCTPV2MessageBeenProcessed(message, svmProvider);
  }
}

/**
 * Processes a CCTP mint transaction on Solana
 * Detects message version and uses appropriate V1 or V2 function
 */
export async function processMintSvm(
  attestation: { message: string; attestation: string },
  svmPrivateKey: Uint8Array,
  svmProvider: SVMProvider,
  destinationChainId: number,
  originChainId: number,
  logger: winston.Logger
): Promise<{ txHash: string }> {
  const svmSigner = await createKeyPairSignerFromBytes(svmPrivateKey);

  const messageBytes = ethers.utils.arrayify(attestation.message);
  const messageBytesArray = ethers.utils.arrayify(messageBytes);

  const version = Number(ethers.utils.hexlify(messageBytesArray.slice(0, 4)));
  const sourceDomain = Number(ethers.utils.hexlify(messageBytesArray.slice(4, 8)));
  const nonce = Number(ethers.utils.hexlify(messageBytesArray.slice(12, 20)));
  const recipient = ethers.utils.hexlify(messageBytesArray.slice(52, 84));

  logger.info({
    at: "svmUtils#processMintSvm",
    message: "Processing CCTP message",
    version,
    sourceDomain,
    nonce,
  });

  const attestedMessage: sdk.arch.svm.AttestedCCTPMessage = {
    nonce,
    sourceDomain,
    messageBytes: attestation.message,
    attestation: attestation.attestation,
    type: "transfer",
  };

  let txSignature = undefined;

  // Version 0 = V1, Version 1 = V2
  if (version === 0) {
    const receiveMessageTx = await sdk.arch.svm.getCCTPV1ReceiveMessageTx(
      svmProvider,
      svmSigner,
      attestedMessage,
      1, // hubChainId
      SvmAddress.from(recipient)
    );
    txSignature = await sendAndConfirmSolanaTransaction(receiveMessageTx, svmProvider);
  } else {
    logger.info({
      at: "svmUtils#processMintSvm",
      message: "Processing CCTP V2 message on Solana",
      destinationChainId,
      originChainId,
      nonce,
    });
    txSignature = await sendAndConfirmCCTPV2ReceiveMessageTx({
      provider: svmProvider,
      signer: svmSigner,
      attestation: attestation.attestation,
      message: attestation.message,
      destinationChainId,
      originChainId,
      logger,
    });
  }

  logger.info({
    at: "svmUtils#processMintSvm",
    message: "Mint transaction confirmed on Solana",
    version,
    txHash: txSignature,
  });

  return { txHash: txSignature };
}
