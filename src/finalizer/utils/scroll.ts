/* eslint-disable @typescript-eslint/no-unused-vars */
import { utils as sdkUtils } from "@across-protocol/sdk-v2";
import { TransactionRequest } from "@ethersproject/abstract-provider";
import axios from "axios";
import { HubPoolClient, SpokePoolClient } from "../../clients";
import { CONTRACT_ADDRESSES, Multicall2Call } from "../../common";
import { Contract, Signer, winston } from "../../utils";
import { FinalizerPromise, Withdrawal } from "../types";
import { VoidSigner, providers } from "ethers";
import { ZERO_ADDRESS } from "@uma/common";

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
  spokePoolClient: SpokePoolClient,
  // Not used, but required for the interface
  _firstBlockToFinalize: number
): Promise<FinalizerPromise> {
  const [l1ChainId, l2ChainId, targetAddress] = [
    hubPoolClient.chainId,
    spokePoolClient.chainId,
    spokePoolClient.spokePool.address,
  ];

  const relayContract = getScrollRelayContract(l1ChainId, signer);
  const outstandingClaims = await findOutstandingClaims(targetAddress, logger);
  const [callData, withdrawals] = await Promise.all([
    sdkUtils.mapAsync(outstandingClaims, (claim) => populateClaimTransaction(claim, relayContract)),
    outstandingClaims.map((claim) => populateClaimWithdrawal(claim, l2ChainId, hubPoolClient)),
  ]);

  return {
    withdrawals: [],
    callData: [],
  };
}

/**
 * Resolves all outstanding claims from Scroll -> Mainnet. This is done by
 * querying the Scroll API for all outstanding claims.
 * @param targetAddress The address to query for outstanding claims
 * @param logger The logger to use for logging
 * @returns A list of all outstanding claims
 */
async function findOutstandingClaims(targetAddress: string, logger: winston.Logger) {
  // By default, the URL link is to the mainnet API. If we want to
  // test on a testnet, we can change the URL to the testnet API.
  // I.e. Switch to https://sepolia-api-bridge.scroll.io/api/claimable
  const apiUrl = "https://sepolia-api-bridge.scroll.io/api/claimable";
  const claimList = (
    await axios.get<{
      data: {
        result: {
          claimInfo: ScrollClaimInfo;
          l1Token: string;
        }[];
      };
    }>(apiUrl, {
      params: {
        address: targetAddress,
      },
    })
  ).data.data.result.map(({ claimInfo, l1Token }) => ({
    ...claimInfo,
    l1Token,
  }));
  logger.debug({
    at: "Finalizer#ScrollFinalizer",
    message: `Detected ${claimList.length} claims for ${targetAddress}`,
  });
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

  const testnetRelayAddress = "0x50c7d3e7f7c656493D1D76aaa1a836CedfCBB16A";
  const sepoliaSigner = new VoidSigner(
    ZERO_ADDRESS,
    new providers.StaticJsonRpcProvider("https://ethereum-sepolia.publicnode.com	")
  );
  return new Contract(testnetRelayAddress, scrollRelayAbi, sepoliaSigner);
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
): Withdrawal {
  const l1Token = hubPoolClient.getTokenInfo(hubPoolClient.chainId, claim.l1Token);
  return {
    l2ChainId,
    l1TokenSymbol: l1Token.symbol,
    amount: claim.value,
    type: "withdrawal",
  };
}
