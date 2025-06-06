import { TransactionRequest } from "@ethersproject/abstract-provider";
import { MessageTransmitterIdl, TokenMessengerMinterIdl } from "@across-protocol/contracts";
import { web3, BN } from "@coral-xyz/anchor";
import { TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import { HubPoolClient, SpokePoolClient } from "../../../clients";
import {
  Contract,
  EventSearchConfig,
  Signer,
  TOKEN_SYMBOLS_MAP,
  assert,
  groupObjectCountsByProp,
  isDefined,
  Multicall2Call,
  winston,
  convertFromWei,
  isEVMSpokePoolClient,
  getAnchorProgram,
  Wallet,
  mapAsync,
  getSvmSignerFromEvmSigner,
  toPublicKey,
  CHAIN_IDs,
  getAssociatedTokenAddress,
  SvmAddress,
  EvmAddress,
  ethers,
  chainIsProd,
} from "../../../utils";
import {
  AttestedCCTPDepositEvent,
  CCTPMessageStatus,
  getAttestationsForCCTPDepositEvents,
  getCctpMessageTransmitter,
} from "../../../utils/CCTPUtils";
import { FinalizerPromise, CrossChainMessage } from "../../types";

export async function cctpL1toL2Finalizer(
  logger: winston.Logger,
  _signer: Signer,
  hubPoolClient: HubPoolClient,
  l2SpokePoolClient: SpokePoolClient,
  l1SpokePoolClient: SpokePoolClient,
  senderAddresses: string[]
): Promise<FinalizerPromise> {
  assert(isEVMSpokePoolClient(l1SpokePoolClient));
  const searchConfig: EventSearchConfig = {
    from: l1SpokePoolClient.eventSearchConfig.from,
    to: l1SpokePoolClient.latestHeightSearched,
    maxLookBack: l1SpokePoolClient.eventSearchConfig.maxLookBack,
  };
  const outstandingDeposits = await getAttestationsForCCTPDepositEvents(
    senderAddresses,
    hubPoolClient.chainId,
    l2SpokePoolClient.chainId,
    l2SpokePoolClient.chainId,
    searchConfig
  );
  const unprocessedMessages = outstandingDeposits.filter(
    (message) => message.status === "ready" && message.attestation !== "PENDING"
  );
  const statusesGrouped = groupObjectCountsByProp(
    outstandingDeposits,
    (message: { status: CCTPMessageStatus }) => message.status
  );
  logger.debug({
    at: `Finalizer#CCTPL1ToL2Finalizer:${l2SpokePoolClient.chainId}`,
    message: `Detected ${unprocessedMessages.length} ready to finalize messages for CCTP L1 to ${l2SpokePoolClient.chainId}`,
    statusesGrouped,
  });

  const { address, abi } = getCctpMessageTransmitter(l2SpokePoolClient.chainId, l2SpokePoolClient.chainId);
  if (isEVMSpokePoolClient(l2SpokePoolClient)) {
    const l2Messenger = new ethers.Contract(address, abi, l2SpokePoolClient.spokePool.provider);
    return {
      crossChainMessages: await generateDepositData(
        unprocessedMessages,
        hubPoolClient.chainId,
        l2SpokePoolClient.chainId
      ),
      callData: await generateMultiCallData(l2Messenger, unprocessedMessages),
    };
  } else {
    const simulate = process.env["SEND_TRANSACTIONS"] !== "true";
    // If the l2SpokePoolClient is not an EVM client, then we must have send the finalization here, since we cannot return SVM calldata.
    const signatures = await finalizeSvmWithdrawals(
      unprocessedMessages,
      hubPoolClient.hubPool.signer,
      simulate,
      hubPoolClient.chainId
    );
    const amountFinalized = unprocessedMessages.reduce((acc, event) => acc + Number(event.amount), 0);
    logger[simulate || amountFinalized === 0 ? "debug" : "info"]({
      at: `Finalizer#CCTPL1ToL2Finalizer:${l2SpokePoolClient.chainId}`,
      message: `Finalized ${unprocessedMessages.length} deposits on Solana for ${convertFromWei(
        String(amountFinalized),
        TOKEN_SYMBOLS_MAP.USDC.decimals
      )} USDC.`,
      signatures,
    });
    return {
      crossChainMessages: [],
      callData: [],
    };
  }
}

/**
 * Generates a series of populated transactions that can be consumed by the Multicall2 contract.
 * @param messageTransmitter The CCTPMessageTransmitter contract that will be used to populate the transactions.
 * @param messages The messages to generate transactions for.
 * @returns A list of populated transactions that can be consumed by the Multicall2 contract.
 */
async function generateMultiCallData(
  messageTransmitter: Contract,
  messages: Pick<AttestedCCTPDepositEvent, "attestation" | "messageBytes">[]
): Promise<Multicall2Call[]> {
  assert(messages.every(({ attestation }) => isDefined(attestation) && attestation !== "PENDING"));
  return Promise.all(
    messages.map(async (message) => {
      const txn = (await messageTransmitter.populateTransaction.receiveMessage(
        message.messageBytes,
        message.attestation
      )) as TransactionRequest;
      return {
        target: txn.to,
        callData: txn.data,
      };
    })
  );
}

/**
 * Generates a list of valid withdrawals for a given list of CCTP messages.
 * @param messages The CCTP messages to generate withdrawals for.
 * @param originationChainId The chain that these messages originated from
 * @param destinationChainId The chain that these messages will be executed on
 * @returns A list of valid withdrawals for a given list of CCTP messages.
 */
async function generateDepositData(
  messages: Pick<AttestedCCTPDepositEvent, "amount">[],
  originationChainId: number,
  destinationChainId: number
): Promise<CrossChainMessage[]> {
  return messages.map((message) => ({
    l1TokenSymbol: "USDC", // Always USDC b/c that's the only token we support on CCTP
    amount: convertFromWei(message.amount, TOKEN_SYMBOLS_MAP.USDC.decimals), // Format out to 6 decimal places for USDC
    type: "deposit",
    originationChainId,
    destinationChainId,
  }));
}

/**
 * Finalizes CCTP deposits on Solana.
 * @param deposits The CCTP deposits to withdraw on Solana.
 * @param signer A base signer to be converted into a Solana signer.
 * @returns A list of executed transaction signatures.
 */
async function finalizeSvmWithdrawals(
  deposits: AttestedCCTPDepositEvent[],
  signer: Signer,
  simulate = false,
  hubChainId = 1
): Promise<string[]> {
  const l1Usdc = EvmAddress.from(TOKEN_SYMBOLS_MAP.USDC.addresses[hubChainId]);
  const l2Usdc = SvmAddress.from(
    TOKEN_SYMBOLS_MAP.USDC.addresses[chainIsProd(hubChainId) ? CHAIN_IDs.SOLANA : CHAIN_IDs.SOLANA_DEVNET]
  );
  const [svmSigner, messageTransmitterProgram] = await Promise.all([
    getSvmSignerFromEvmSigner(signer as Wallet),
    getAnchorProgram(MessageTransmitterIdl, signer as Wallet),
  ]);
  const messageTransmitter = toPublicKey(MessageTransmitterIdl.address);
  const tokenMessengerMinter = toPublicKey(TokenMessengerMinterIdl.address);

  // Define global accounts to access.
  const [messageTransmitterPda] = web3.PublicKey.findProgramAddressSync(
    [Buffer.from("message_transmitter")],
    messageTransmitter
  );
  const [tokenMessengerPda] = web3.PublicKey.findProgramAddressSync(
    [Buffer.from("token_messenger")],
    tokenMessengerMinter
  );
  const [tokenMinterPda] = web3.PublicKey.findProgramAddressSync([Buffer.from("token_minter")], tokenMessengerMinter);
  const [localTokenPda] = web3.PublicKey.findProgramAddressSync(
    [Buffer.from("local_token"), l2Usdc.toBuffer()],
    tokenMessengerMinter
  );
  const [tokenMessengerEventAuthorityPda] = web3.PublicKey.findProgramAddressSync(
    [Buffer.from("__event_authority")],
    tokenMessengerMinter
  );
  const [custodyTokenAccountPda] = web3.PublicKey.findProgramAddressSync(
    [Buffer.from("custody"), l2Usdc.toBuffer()],
    tokenMessengerMinter
  );
  const [authorityPda] = web3.PublicKey.findProgramAddressSync(
    [Buffer.from("message_transmitter_authority"), tokenMessengerMinter.toBuffer()],
    messageTransmitter
  );
  const tokenAccount = await getAssociatedTokenAddress(SvmAddress.from(svmSigner.publicKey.toBase58()), l2Usdc);
  return mapAsync(deposits, async (deposit) => {
    // Define accounts dependent on deposit information.
    const [tokenPairPda] = web3.PublicKey.findProgramAddressSync(
      [
        Buffer.from("token_pair"),
        Buffer.from(String(deposit.sourceDomain)),
        Buffer.from(l1Usdc.toBytes32().slice(2), "hex"),
      ],
      tokenMessengerMinter
    );
    const [remoteTokenMessengerPda] = web3.PublicKey.findProgramAddressSync(
      [Buffer.from("remote_token_messenger"), Buffer.from(String(deposit.sourceDomain))],
      tokenMessengerMinter
    );
    const noncePda = await messageTransmitterProgram.methods
      .getNoncePda({ nonce: new BN(deposit.log.args.nonce.toNumber()), sourceDomain: deposit.log.args.remoteDomain })
      .accounts({ messageTransmitter: messageTransmitterPda })
      .view();

    // Append extra accounts.
    const accountMetas = [
      {
        isSigner: false,
        isWritable: false,
        pubkey: tokenMessengerPda,
      },
      {
        isSigner: false,
        isWritable: false,
        pubkey: remoteTokenMessengerPda,
      },
      {
        isSigner: false,
        isWritable: true,
        pubkey: tokenMinterPda,
      },
      {
        isSigner: false,
        isWritable: true,
        pubkey: localTokenPda,
      },
      {
        isSigner: false,
        isWritable: false,
        pubkey: tokenPairPda,
      },
      {
        isSigner: false,
        isWritable: true,
        pubkey: toPublicKey(tokenAccount),
      },
      {
        isSigner: false,
        isWritable: true,
        pubkey: custodyTokenAccountPda,
      },
      {
        isSigner: false,
        isWritable: false,
        pubkey: toPublicKey(TOKEN_PROGRAM_ADDRESS),
      },
      {
        isSigner: false,
        isWritable: false,
        pubkey: tokenMessengerEventAuthorityPda,
      },
      {
        isSigner: false,
        isWritable: false,
        pubkey: tokenMessengerMinter,
      },
    ];

    const pendingTx = messageTransmitterProgram.methods
      .receiveMessage({
        message: Buffer.from(deposit.messageBytes.slice(2), "hex"),
        attestation: Buffer.from(deposit.attestation.slice(2), "hex"),
      })
      .accounts({
        payer: svmSigner.publicKey,
        caller: svmSigner.publicKey,
        authorityPda,
        messageTransmitter: messageTransmitterPda,
        usedNonces: noncePda,
        receiver: tokenMessengerMinter,
        systemProgram: web3.SystemProgram.programId,
      })
      .remainingAccounts(accountMetas);
    if (simulate) {
      await pendingTx.simulate();
      return "";
    }
    return pendingTx.rpc();
  });
}
