import { expect } from "chai";
import { filterRequiredActions, type HeliosAction } from "../src/finalizer/utils/helios";
import type { HubPoolClient, SpokePoolClient } from "../src/clients";
import type { StoredCallDataEvent } from "../src/interfaces/Universal";
import { toBN, ZERO_ADDRESS } from "../src/utils";

// Plasma. Stands in for "a Universal chain whose pool rebalance leaf was executed in a different
// `executeRootBundle()` transaction than the one that stored the shared relayRootBundle message".
const L2_CHAIN_ID = 9745;
const CHALLENGE_PERIOD_END_TIMESTAMP = 1782213311;

function storedCallDataEvent(overrides: Partial<StoredCallDataEvent> = {}): StoredCallDataEvent {
  return {
    // The HubPoolStore stores the shared relayRootBundle message with `target == address(0)` and
    // `nonce == challengePeriodEndTimestamp`.
    target: ZERO_ADDRESS,
    data: "0x",
    nonce: toBN(CHALLENGE_PERIOD_END_TIMESTAMP),
    blockNumber: 100,
    txnIndex: 0,
    logIndex: 0,
    txnRef: "0xstore",
    ...overrides,
  } as unknown as StoredCallDataEvent;
}

function updateAndExecuteAction(l1Event: StoredCallDataEvent): HeliosAction {
  return { type: "UpdateAndExecute", l1Event } as HeliosAction;
}

function makeHubPoolClient(opts: {
  proposals: { challengePeriodEndTimestamp: number; blockNumber: number }[];
  executedLeafChainIds: number[];
}): HubPoolClient {
  return {
    latestHeightSearched: 1_000_000,
    getProposedRootBundles: () => opts.proposals,
    getFollowingRootBundle: () => undefined,
    getExecutedLeavesForRootBundle: () => opts.executedLeafChainIds.map((chainId) => ({ chainId })),
  } as unknown as HubPoolClient;
}

const dummySpokePoolClient = {} as unknown as SpokePoolClient;

describe("Helios finalizer: filterRequiredActions", function () {
  it("keeps the shared relayRootBundle action once this chain's leaf has executed, even when it executed in a different transaction than the one that stored the message", function () {
    // Regression test: the message was stored in tx 0xstore (by some other Universal chain's
    // executeRootBundle), but this chain's leaf executed in a separate batch. The action must still
    // be kept -- gating is on whether this chain's leaf for the bundle executed, not on tx equality.
    const action = updateAndExecuteAction(storedCallDataEvent({ txnRef: "0xstore" }));
    const hubPoolClient = makeHubPoolClient({
      proposals: [{ challengePeriodEndTimestamp: CHALLENGE_PERIOD_END_TIMESTAMP, blockNumber: 50 }],
      executedLeafChainIds: [1, L2_CHAIN_ID],
    });

    const result = filterRequiredActions(hubPoolClient, dummySpokePoolClient, L2_CHAIN_ID, [action]);
    expect(result).to.have.length(1);
  });

  it("filters out the shared relayRootBundle action while this chain's leaf has not executed yet", function () {
    const action = updateAndExecuteAction(storedCallDataEvent());
    const hubPoolClient = makeHubPoolClient({
      proposals: [{ challengePeriodEndTimestamp: CHALLENGE_PERIOD_END_TIMESTAMP, blockNumber: 50 }],
      executedLeafChainIds: [1, 143], // other chains executed, but not L2_CHAIN_ID
    });

    const result = filterRequiredActions(hubPoolClient, dummySpokePoolClient, L2_CHAIN_ID, [action]);
    expect(result).to.have.length(0);
  });

  it("keeps the shared relayRootBundle action when the bundle proposal predates the lookback window", function () {
    const action = updateAndExecuteAction(storedCallDataEvent());
    const hubPoolClient = makeHubPoolClient({ proposals: [], executedLeafChainIds: [] });

    const result = filterRequiredActions(hubPoolClient, dummySpokePoolClient, L2_CHAIN_ID, [action]);
    expect(result).to.have.length(1);
  });

  it("keeps admin function actions (non-zero target) without gating on leaf execution", function () {
    const adminTarget = "0x000000000000000000000000000000000000dEaD";
    const action = updateAndExecuteAction(storedCallDataEvent({ target: adminTarget }));
    // No executed leaves for this chain at all -- an admin message must still pass.
    const hubPoolClient = makeHubPoolClient({
      proposals: [{ challengePeriodEndTimestamp: CHALLENGE_PERIOD_END_TIMESTAMP, blockNumber: 50 }],
      executedLeafChainIds: [],
    });

    const result = filterRequiredActions(hubPoolClient, dummySpokePoolClient, L2_CHAIN_ID, [action]);
    expect(result).to.have.length(1);
  });

  it("keeps non-UpdateAndExecute actions untouched", function () {
    const action = { type: "UpdateOnly" } as HeliosAction;
    const hubPoolClient = makeHubPoolClient({ proposals: [], executedLeafChainIds: [] });

    const result = filterRequiredActions(hubPoolClient, dummySpokePoolClient, L2_CHAIN_ID, [action]);
    expect(result).to.have.length(1);
  });
});
