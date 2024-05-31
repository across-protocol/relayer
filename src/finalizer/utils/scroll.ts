/* eslint-disable @typescript-eslint/no-unused-vars */
import { utils as sdkUtils } from "@across-protocol/sdk";
import { TransactionRequest } from "@ethersproject/abstract-provider";
import axios from "axios";
import { HubPoolClient, SpokePoolClient } from "../../clients";
import { CONTRACT_ADDRESSES, Multicall2Call } from "../../common";
import { Contract, Signer, getBlockForTimestamp, getCurrentTime, getRedisCache, winston } from "../../utils";
import { FinalizerPromise, CrossChainMessage } from "../types";

type ScrollClaimInfo = {
  from: string;
  to: string;
  value: string;
  nonce: string;
  message: string;
  proof: string;
  batch_index: string;
};

type ScrollClaimInfoWithL1Token = ScrollClaimInfo & {
  l1Token: string;
};

export async function scrollFinalizer(
  logger: winston.Logger,
  signer: Signer,
  hubPoolClient: HubPoolClient,
  spokePoolClient: SpokePoolClient
): Promise<FinalizerPromise> {
  const [l1ChainId, l2ChainId, targetAddress] = [
    hubPoolClient.chainId,
    spokePoolClient.chainId,
    spokePoolClient.spokePool.address,
  ];
  const relayContract = getScrollRelayContract(l1ChainId, signer);

  // TODO: Why are we not using the SpokePoolClient.getTokensBridged() method here to get a list
  // of all possible withdrawals and then narrowing the Scroll API search afterwards?
  // Why are we breaking with the existing pattern--is it faster?
  // Scroll takes up to 4 hours with finalize a withdrawal so lets search
  // up to 12 hours for withdrawals.
  const lookback = getCurrentTime() - 12 * 60 * 60 * 24;
  const redis = await getRedisCache(logger);
  const fromBlock = await getBlockForTimestamp(l2ChainId, lookback, undefined, redis);
  logger.debug({
    at: "Finalizer#ScrollFinalizer",
    message: "Scroll TokensBridged event filter",
    fromBlock,
  });
  const outstandingClaims = await findOutstandingClaims(targetAddress, fromBlock);

  logger.debug({
    at: "Finalizer#ScrollFinalizer",
    message: `Detected ${outstandingClaims.length} claims for ${targetAddress}`,
  });

  const [callData, crossChainMessages] = await Promise.all([
    sdkUtils.mapAsync(outstandingClaims, (claim) => populateClaimTransaction(claim, relayContract)),
    outstandingClaims.map((claim) => populateClaimWithdrawal(claim, l2ChainId, hubPoolClient)),
  ]);
  return {
    crossChainMessages,
    callData,
  };
}

/**
 * Resolves all outstanding claims from Scroll -> Mainnet. This is done by
 * querying the Scroll API for all outstanding claims.
 * @param targetAddress The address to query for outstanding claims
 * @param latestBlockToFinalize The first block to finalize
 * @returns A list of all outstanding claims
 */
async function findOutstandingClaims(targetAddress: string, latestBlockToFinalize: number) {
  // By default, the URL link is to the mainnet API. If we want to
  // test on a testnet, we can change the URL to the testnet API.
  // I.e. Switch to https://sepolia-api-bridge.scroll.io/api/claimable
  const apiUrl = "https://mainnet-api-bridge.scroll.io/api/claimable";
  const claimList = (
    (
      await axios.get<{
        data: {
          result: {
            claimInfo: ScrollClaimInfo;
            l1Token: string;
            blockNumber: number;
          }[];
        };
      }>(apiUrl, {
        params: {
          address: targetAddress,
        },
      })
    ).data.data?.result ?? []
  )
    .filter(({ blockNumber }) => blockNumber <= latestBlockToFinalize)
    .map(({ claimInfo, l1Token }) => ({
      ...claimInfo,
      l1Token,
    }));
  return claimList;
}

/**
 * Returns the Scroll Relay contract for the given chain ID and signer.
 * @param l1ChainId The chain ID to use - i.e. the hub chain ID
 * @param signer The signer that will be used to sign the transaction
 * @returns A Scroll Relay contract, instnatiated with the given signer
 */
function getScrollRelayContract(l1ChainId: number, signer: Signer) {
  const { abi: scrollRelayAbi, address: scrollRelayAddress } = CONTRACT_ADDRESSES[l1ChainId]?.scrollRelayMessenger;
  return new Contract(scrollRelayAddress, scrollRelayAbi, signer);
}

/**
 * Populates a claim transaction for the given claim and relay contract.
 * @param claim The claim to populate a transaction for
 * @param relayContract The relay contract to use for populating the transaction
 * @returns A populated transaction able to be passed into a Multicall2 call
 */
async function populateClaimTransaction(claim: ScrollClaimInfo, relayContract: Contract): Promise<Multicall2Call> {
  const { to, data } = (await relayContract.populateTransaction.relayMessageWithProof(
    claim.from,
    claim.to,
    claim.value,
    claim.nonce,
    claim.message,
    {
      batchIndex: claim.batch_index,
      merkleProof: claim.proof,
    }
  )) as TransactionRequest;
  return {
    callData: data,
    target: to,
  };
}

/**
 * Populates a withdrawal for the given claim.
 * @param claim The claim to populate a withdrawal for
 * @param l2ChainId The chain ID to use - i.e. the spoke chain ID - for this case it will either be Scroll or Sepolia Scroll
 * @param hubPoolClient The hub pool client to use for getting the L1 token symbol
 * @returns A populated withdrawal
 */
function populateClaimWithdrawal(
  claim: ScrollClaimInfoWithL1Token,
  l2ChainId: number,
  hubPoolClient: HubPoolClient
): CrossChainMessage {
  const l1Token = hubPoolClient.getTokenInfo(hubPoolClient.chainId, claim.l1Token);
  return {
    originationChainId: l2ChainId,
    l1TokenSymbol: l1Token.symbol,
    amount: claim.value,
    type: "withdrawal",
    destinationChainId: hubPoolClient.chainId, // Always on L1
  };
}
