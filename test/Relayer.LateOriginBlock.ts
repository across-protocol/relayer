import winston from "winston";
import { CHAIN_IDs } from "@across-protocol/constants";
import { BLOCK_ARRIVAL_HISTORY, EVMSpokePoolClient, SpokeListener } from "../src/clients";
import { LATE_BLOCK_MIN_CONFIRMATIONS } from "../src/common";
import { DepositWithBlock } from "../src/interfaces";
import { ListenerMessage } from "../src/libexec/types";
import { Relayer } from "../src/relayer/Relayer";
import { RelayerClients } from "../src/relayer/RelayerClientHelper";
import { RelayerConfig } from "../src/relayer/RelayerConfig";
import { EventSearchConfig, getCurrentTime } from "../src/utils";
import { createSpyLogger, deploySpokePoolWithToken, expect, randomAddress } from "./utils";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Constructor<T = EVMSpokePoolClient> = new (...args: any[]) => T;

// Minimum common-ish interface supplied by the SpokePoolClient.
type MinSpokeListener = {
  _indexerUpdate: (message: unknown) => void;
};

function _MockSpokeListener<T extends Constructor<MinSpokeListener>>(SpokeListener: T) {
  return class extends SpokeListener {
    // Permit parent _indexerUpdate method to be called externally.
    indexerUpdate(rawMessage: unknown): void {
      super._indexerUpdate(rawMessage);
    }

    // Suppress spawning of workers.
    protected _startWorker(): void {
      return;
    }
  };
}

describe("Relayer: Late-arriving origin blocks", function () {
  const MockSpokeListener = _MockSpokeListener(SpokeListener(EVMSpokePoolClient));
  const originChainId = CHAIN_IDs.MAINNET;
  const maxLateness = 4; // Seconds.

  let logger: winston.Logger;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let spokePoolClient: any; // nasty @todo
  let blockNumber: number;

  /**
   * Emulates the indexer submitting a block update to the SpokePoolClient.
   */
  const postBlock = (blockNumber: number, currentTime: number): void => {
    const message: ListenerMessage = { blockNumber, currentTime };
    spokePoolClient.indexerUpdate(JSON.stringify(message));
  };

  const makeRelayer = (config: Partial<RelayerConfig>): Relayer =>
    new Relayer(
      randomAddress(),
      logger,
      { spokePoolClients: { [originChainId]: spokePoolClient } } as unknown as RelayerClients,
      { minDepositConfirmations: { [originChainId]: [] }, ...config } as unknown as RelayerConfig
    );

  const makeDeposit = (blockNumber: number): DepositWithBlock =>
    ({ originChainId, blockNumber }) as unknown as DepositWithBlock;

  beforeEach(async function () {
    ({ spyLogger: logger } = createSpyLogger());
    const { spokePool, deploymentBlock } = await deploySpokePoolWithToken(originChainId);

    const searchConfig: EventSearchConfig | undefined = undefined;
    spokePoolClient = new MockSpokeListener(logger, spokePool, null, originChainId, deploymentBlock, searchConfig);
    spokePoolClient.init({});
    blockNumber = 1_000;
  });

  it("Records arrival lateness for blocks observed live", async function () {
    const lateness = 10;
    postBlock(blockNumber, getCurrentTime() - lateness);
    expect(spokePoolClient.getBlockArrivalLateness(blockNumber)).to.be.at.least(lateness);
  });

  it("Records no arrival lateness for blocks that were not observed live", async function () {
    postBlock(blockNumber, getCurrentTime());
    expect(spokePoolClient.getBlockArrivalLateness(blockNumber - 1)).to.be.undefined;
  });

  it("Evicts arrival lateness beyond the retention window", async function () {
    const currentTime = getCurrentTime();
    postBlock(blockNumber, currentTime);
    expect(spokePoolClient.getBlockArrivalLateness(blockNumber)).to.exist;

    // The oldest retained block is exactly BLOCK_ARRIVAL_HISTORY behind the most recent one.
    postBlock(blockNumber + BLOCK_ARRIVAL_HISTORY, currentTime + 1);
    expect(spokePoolClient.getBlockArrivalLateness(blockNumber)).to.exist;

    postBlock(blockNumber + BLOCK_ARRIVAL_HISTORY + 1, currentTime + 2);
    expect(spokePoolClient.getBlockArrivalLateness(blockNumber)).to.be.undefined;
  });

  it("Withholds a deposit sourced from a late-arriving origin block until it is confirmed", async function () {
    const relayer = makeRelayer({ maxOriginBlockLateness: { [originChainId]: maxLateness } });
    postBlock(blockNumber, getCurrentTime() - maxLateness);
    const deposit = makeDeposit(blockNumber);

    // No block has been built on top of the deposit's origin block.
    spokePoolClient.latestHeightSearched = blockNumber;
    expect(relayer.originBlockUnsettled(deposit)).to.be.true;

    spokePoolClient.latestHeightSearched = blockNumber + LATE_BLOCK_MIN_CONFIRMATIONS - 1;
    expect(relayer.originBlockUnsettled(deposit)).to.be.true;

    spokePoolClient.latestHeightSearched = blockNumber + LATE_BLOCK_MIN_CONFIRMATIONS;
    expect(relayer.originBlockUnsettled(deposit)).to.be.false;
  });

  it("Does not withhold a deposit sourced from a punctual origin block", async function () {
    const relayer = makeRelayer({ maxOriginBlockLateness: { [originChainId]: maxLateness } });
    postBlock(blockNumber, getCurrentTime());

    spokePoolClient.latestHeightSearched = blockNumber;
    expect(relayer.originBlockUnsettled(makeDeposit(blockNumber))).to.be.false;
  });

  it("Does not withhold a deposit whose origin block was not observed live", async function () {
    const relayer = makeRelayer({ maxOriginBlockLateness: { [originChainId]: maxLateness } });
    postBlock(blockNumber, getCurrentTime() - maxLateness);

    // Nothing was recorded for the preceding block, so it can't be known to be late.
    spokePoolClient.latestHeightSearched = blockNumber;
    expect(relayer.originBlockUnsettled(makeDeposit(blockNumber - 1))).to.be.false;
  });

  it("Does not withhold when the origin chain threshold is zero", async function () {
    const relayer = makeRelayer({ maxOriginBlockLateness: { [originChainId]: 0 } });
    postBlock(blockNumber, getCurrentTime() - 60);

    spokePoolClient.latestHeightSearched = blockNumber;
    expect(relayer.originBlockUnsettled(makeDeposit(blockNumber))).to.be.false;
  });

  it("Does not withhold when no threshold is configured at all", async function () {
    const relayer = makeRelayer({});
    postBlock(blockNumber, getCurrentTime() - 60);

    spokePoolClient.latestHeightSearched = blockNumber;
    expect(relayer.originBlockUnsettled(makeDeposit(blockNumber))).to.be.false;
  });
});
