import { getCurrentTime, Logger, processEndPollingLoop, winston } from "../utils";
import { request, gql } from "graphql-request";
import { createEtherscanLinkMarkdown, formatDate } from "@uma/common";
require("dotenv").config();

// Snapshot GraphQL Proposal query.
// source: https://docs.snapshot.org/guides/graphql-api#proposal
interface Proposal {
  proposals: {
    id: string;
    title: string;
    body: string;
    choices: string[];
    start: number;
    end: number;
    created: number;
    snapshot: number;
    state: string;
    scores: number[];
    scores_total: number;
    scores_updated: number;
    author: string;
    plugins: {
      safeSnap: {
        safes: {
          txs: {
            hash: string;
            nonce: number;
            transactions: {
              to: string;
              abi?: string[];
              data: string;
              type: string;
              nonce: number;
              value: string;
              [key: string]: any;
            }[];
          };
          hash: string;
          network: string;
          umaAddress: string;
          realityAddress: string;
        }[];
        valid: boolean;
      };
    };
  }[];
}

/**
 * Logs oSnap-compatible proposals submitted to Snapshot that were created within the lookback window.
 * @param logger
 * @param lookback How far back to look for proposals submitted. Defaults to 30 mins.
 * @param snapshotSpace The snapshot space to query for proposals. Defaults to "acrossprotocol.eth"
 * @param endpoint The graphql endpoint to query. Defaults to "https://hub.snapshot.org/graphql"
 * @param snapshotUiUrl The snapshot UI url to link to for easy viewing of proposals.
 * Defaults to "https://snapshot.org/#"
 */
async function checkForSnapshotProposals(
  logger: winston.Logger,
  lookback = 30 * 60,
  snapshotSpace = "acrossprotocol.eth",
  endpoint = "https://hub.snapshot.org/graphql",
  snapshotUiUrl = "https://snapshot.org/#"
) {
  // Check for proposals created within lookback.
  const currentTime = getCurrentTime();
  if (lookback > currentTime) throw new Error("Lookback cannot be greater than current time");
  const startTime = currentTime - lookback;

  logger.debug({
    at: "Snapshot Monitor ⚡️",
    message: "Looking for new proposals",
    monitorStartTime: startTime,
    snapshotSpace,
    endpoint,
    snapshotUiUrl,
  });

  // TODO: Filter on `created_gt: lookback` to filter out proposals created after the lookback
  // const lookback = currentTime - this.monitorConfig.maxRelayerLookBack;
  // Use the variables feature https://github.com/jasonkuhrt/graphql-request#using-graphql-document-variables

  // Proposals that are eligible to be executed via oSnap must have a `safeSnap` plugin specified.
  // We'll only monitor these proposal for now.
  // Note: If there are more than 100 proposals created in the lookback, then this will only log the first
  // 100. This is a limitation of the GraphQL API, in that we must specify the number of data objects to return.
  // 100 seems like a safe upper limit that we should practically never hit.
  const query = gql`
    query getProposals($snapshotSpace: String!, $startTime: Int!) {
      proposals(
        first: 100
        skip: 0
        where: { space: $snapshotSpace, plugins_contains: "safeSnap", created_gt: $startTime }
        orderBy: "created"
        orderDirection: desc
      ) {
        id
        title
        body
        created
        start
        end
        snapshot
        state
        choices
        scores
        scores_total
        scores_updated
        author
        plugins
      }
    }
  `;
  const variables = {
    snapshotSpace,
    startTime,
  };

  // // For any proposals compatible with oSnap, the umaAddress should be set to the oSnap module address
  // // and the realityAddress should be set to the following hardcoded string.
  // const expectedRealityAddress = "0xSWITCH_WITH_UMA_MODULE_ADDRESS";

  const response = await request<Proposal>(endpoint, query, variables);
  for (const proposal of response.proposals) {
    logger.warn({
      at: "Snapshot Monitor",
      message: "New oSnap proposal detected ⚡️",
      proposalUrl: `${snapshotUiUrl}/${snapshotSpace}/proposal/${proposal.id}`,
      id: proposal.id,
      title: proposal.title,
      start: formatDate(proposal.start),
      end: formatDate(proposal.end),
      created: formatDate(proposal.created),
      choices: proposal.choices,
      votes: proposal.scores,
      votesTotal: proposal.scores_total,
      latestVote: formatDate(proposal.scores_updated),
      author: createEtherscanLinkMarkdown(proposal.author, 1),
      safeSnap: proposal.plugins.safeSnap,
    });
  }
}

export async function run(_logger: winston.Logger): Promise<void> {
  const lookback =
    process.env.SNAPSHOT_PROPOSAL_MONITOR_LOOKBACK && Number(process.env.SNAPSHOT_PROPOSAL_MONITOR_LOOKBACK);
  await checkForSnapshotProposals(
    _logger,
    lookback,
    process.env.SNAPSHOT_PROPOSAL_MONITOR_SPACE,
    process.env.SNAPSHOT_PROPOSAL_MONITOR_ENDPOINT,
    process.env.SNAPSHOT_PROPOSAL_MONITOR_UI_URL
  );
  await processEndPollingLoop(_logger, "querySnapshotProposals", 0);
}

// eslint-disable-next-line no-process-exit
run(Logger).then(async () => process.exit(0));
