import { KeyPairSigner, appendTransactionMessageInstructions, pipe, address, generateKeyPairSigner } from "@solana/kit";
import { SVMSpokePoolClient } from "../../../../clients";
import { CONTRACT_ADDRESSES, CCTP_MAX_SEND_AMOUNT } from "../../../../common";
import {
  winston,
  SvmAddress,
  sendAndConfirmSolanaTransaction,
  simulateSolanaTransaction,
  toKitAddress,
  CHAIN_IDs,
  getCCTPDepositAccounts,
  createDefaultTransaction,
  getAssociatedTokenAddress,
  getStatePda,
  getTransferLiabilityPda,
  TOKEN_SYMBOLS_MAP,
  PUBLIC_NETWORKS,
  chainIsProd,
  getEventAuthority,
  createFormatFunction,
} from "../../../../utils";
import { SvmSpokeClient } from "@across-protocol/contracts";

/**
 * Initiates a withdrawal from the Solana spoke pool.
 *
 * @param solanaClient The Solana client.
 * @param signer A base signer to be converted into a Solana signer.
 * @param simulate Whether to simulate the transaction.
 * @param hubChainId The chain ID of the hub.
 * @returns A list of executed transaction signatures.
 */
export async function bridgeTokensToHubPool(
  solanaClient: SVMSpokePoolClient,
  signer: KeyPairSigner,
  logger: winston.Logger,
  hubChainId = CHAIN_IDs.MAINNET
): Promise<{ message: string; signature?: string }> {
  const svmProvider = solanaClient.svmEventsClient.getRpc();
  const svmSpoke = solanaClient.spokePoolAddress;
  const svmSpokeProgramId = toKitAddress(svmSpoke);

  const l2ChainId = chainIsProd(hubChainId) ? CHAIN_IDs.SOLANA : CHAIN_IDs.SOLANA_DEVNET;
  const { address: tokenMessengerAddress } = CONTRACT_ADDRESSES[l2ChainId].cctpTokenMessenger;
  const { address: messageTransmitterAddress } = CONTRACT_ADDRESSES[l2ChainId].cctpMessageTransmitter;
  const l2Usdc = SvmAddress.from(TOKEN_SYMBOLS_MAP.USDC.addresses[l2ChainId]);
  const destinationDomain = PUBLIC_NETWORKS[hubChainId].cctpDomain;

  // Before we get all the information necessary to initiate a CCTP withdrawal, we need to check whether
  // the transfer liability PDA has any pending withdraw amounts.
  const transferLiability = await getTransferLiabilityPda(svmSpokeProgramId, toKitAddress(l2Usdc));
  const transferLiabilityAccount = await SvmSpokeClient.fetchTransferLiability(svmProvider, transferLiability);
  const pendingWithdrawAmount = Math.min(
    Number(transferLiabilityAccount.data.pendingToHubPool),
    CCTP_MAX_SEND_AMOUNT.toNumber()
  );
  if (pendingWithdrawAmount === 0) {
    return {
      message: "Transfer liability account has no pending withdraw amount.",
    };
  }

  // If there is an amount to withdraw, then fetch all accounts and send the transaction.
  const [state, eventAuthority, cctpDepositAccounts, messageSentEventData] = await Promise.all([
    getStatePda(svmSpokeProgramId),
    getEventAuthority(svmSpokeProgramId),
    getCCTPDepositAccounts(
      hubChainId,
      destinationDomain,
      address(tokenMessengerAddress),
      address(messageTransmitterAddress)
    ),
    generateKeyPairSigner(),
  ]);
  const {
    tokenMessengerMinterSenderAuthority,
    messageTransmitter,
    tokenMessenger,
    remoteTokenMessenger,
    tokenMinter,
    localToken,
    cctpEventAuthority,
  } = cctpDepositAccounts;
  const vault = await getAssociatedTokenAddress(SvmAddress.from(state.toString()), l2Usdc);
  const bridgeTokensToHubPoolIx = SvmSpokeClient.getBridgeTokensToHubPoolInstruction({
    signer,
    payer: signer,
    mint: toKitAddress(l2Usdc),
    state,
    transferLiability,
    vault,
    tokenMessengerMinterSenderAuthority,
    messageTransmitter,
    tokenMessenger,
    remoteTokenMessenger,
    tokenMinter,
    localToken,
    cctpEventAuthority,
    messageSentEventData,
    eventAuthority,
    program: svmSpokeProgramId,
    amount: pendingWithdrawAmount,
  });
  const bridgeTokensToHubPoolTx = pipe(await createDefaultTransaction(svmProvider, signer), (tx) =>
    appendTransactionMessageInstructions([bridgeTokensToHubPoolIx], tx)
  );
  const formatUsdc = createFormatFunction(2, 4, false, 6);
  if ((process.env.SEND_TRANSACTIONS === "true") {
    const withdrawSignature = await sendAndConfirmSolanaTransaction(bridgeTokensToHubPoolTx, signer, svmProvider);
    return {
      message: `Withdrew ${formatUsdc(pendingWithdrawAmount.toString())} USDC from Solana to the hub pool.`,
      signature: withdrawSignature,
    };
  }
  const withdrawSimulation = await simulateSolanaTransaction(bridgeTokensToHubPoolTx, svmProvider);
  return {
    message: `Simulated withdrawal of ${formatUsdc(pendingWithdrawAmount.toString())} USDC with result ${
      withdrawSimulation?.value?.logs
    }`,
    signature: "",
  };
}
