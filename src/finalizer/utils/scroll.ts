/* eslint-disable @typescript-eslint/no-unused-vars */
import { utils as sdkUtils } from "@across-protocol/sdk";
import axios from "axios";
import { HubPoolClient, SpokePoolClient } from "../../clients";
import { CONTRACT_ADDRESSES } from "../../common";
import {
  Contract,
  Signer,
  getBlockForTimestamp,
  getCurrentTime,
  getRedisCache,
  Multicall2Call,
  winston,
  convertFromWei,
} from "../../utils";
import { FinalizerPromise, CrossChainMessage } from "../types";

// The highest amount of pending finalizations the scroll API can return.
const MAX_PAGE_SIZE = 100;
// The value in ScrollClaimInfo is 0 unless it is a Weth withdrawal, in which case, value === tokenAmount. Essentially, `tokenAmount` is used to format messages properly, while
// `value` is used to construct valid withdrawal proofs.
type ScrollClaimInfo = {
  from: string;
  to: string;
  value: string;
  nonce: string;
  message: string;
  proof: Proof;
  claimable: boolean;
  tokenAmount: string;
};

type Proof = {
  batch_index: string;
  merkle_proof: string;
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
  logger.debug({
    at: "Finalizer#ScrollFinalizer",
    message: "Scroll TokensBridged event filter",
  });
  const outstandingClaims = await findOutstandingClaims(targetAddress);

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
 * @returns A list of all outstanding claims
 */
async function findOutstandingClaims(targetAddress: string): Promise<ScrollClaimInfoWithL1Token[]> {
  // By default, the URL link is to the mainnet API. If we want to
  // test on a testnet, we can change the URL to the testnet API.
  // I.e. Switch to https://sepolia-api-bridge.scroll.io/api/claimable
  const apiUrl = "https://mainnet-api-bridge-v2.scroll.io/api/l2/unclaimed/withdrawals";
  const claimList: ScrollClaimInfoWithL1Token[] = [];
  let currentPage = 1;
  let requestResponse = [];
  do {
    requestResponse =
      (
        await axios.get<{
          data: {
            results: {
              claim_info: ScrollClaimInfo;
              l1_token_address: string;
              token_amounts: string[];
            }[];
          };
        }>(apiUrl, {
          params: {
            address: targetAddress,
            page_size: MAX_PAGE_SIZE,
            page: currentPage,
          },
        })
      ).data.data?.results ?? [];
    claimList.push(
      ...requestResponse
        .filter(({ claim_info }) => claim_info?.claimable)
        .map(({ claim_info, l1_token_address, token_amounts }) => ({
          ...claim_info,
          tokenAmount: token_amounts[0],
          l1Token: l1_token_address,
        }))
    );
    currentPage++;
  } while (requestResponse.length !== 0);
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
  const { to, data } = await relayContract.populateTransaction.relayMessageWithProof(
    claim.from,
    claim.to,
    claim.value,
    claim.nonce,
    claim.message,
    {
      batchIndex: claim.proof.batch_index,
      merkleProof: claim.proof.merkle_proof,
    }
  );
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
    amount: convertFromWei(claim.tokenAmount, l1Token.decimals),
    type: "withdrawal",
    destinationChainId: hubPoolClient.chainId, // Always on L1
  };
}
