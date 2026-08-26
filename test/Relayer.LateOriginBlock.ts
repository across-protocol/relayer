import winston from "winston";
import { CHAIN_IDs } from "@across-protocol/constants";
import { BLOCK_ARRIVAL_HISTORY, EVMSpokePoolClient, SpokeListener } from "../src/clients";
import { LATE_BLOCK_MIN_CONFIRMATIONS, ProcessEnv } from "../src/common";
import { DepositWithBlock } from "../src/interfaces";
import { ListenerMessage } from "../src/libexec/types";
import { Relayer } from "../src/relayer/Relayer";
import { RelayerClients } from "../src/relayer/RelayerClientHelper";
import { RelayerConfig } from "../src/relayer/RelayerConfig";
import { EventSearchConfig, getCurrentTime } from "../src/utils";
import { createSpyLogger, deploySpokePoolWithToken, expect, lastSpyLogIncludes, randomAddress } from "./utils";

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
  const maxDelay = 4; // Seconds.

  let logger: winston.Logger;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let spy: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let spokePoolClient: any; // nasty @todo
  let blockNumber: number;

  /**
   * Emulates the indexer pushing a live block update to the SpokePoolClient. observedAt defaults to now, as the
   * live listener stamps it on receipt; pass null to emulate a polled update, which carries no observation time.
   */
  const postBlock = (blockNumber: number, currentTime: number, observedAt: number | null = getCurrentTime()): void => {
    const message: ListenerMessage = { blockNumber, currentTime, ...(observedAt === null ? {} : { observedAt }) };
    spokePoolClient.indexerUpdate(JSON.stringify(message));
  };

  /** Emulates the indexer reporting that a deposit's origin event was removed upstream. */
  const postRemoval = (blockNumber: number, transactionHash: string): void => {
    const event = {
      event: "FundsDeposited",
      blockNumber,
      blockHash: "0xdeadbeef",
      transactionHash,
      logIndex: 0,
      args: { depositId: 1 },
    };
    spokePoolClient.indexerUpdate(JSON.stringify({ event: JSON.stringify(event) }));
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
    ({ spy, spyLogger: logger } = createSpyLogger());
    const { spokePool, deploymentBlock } = await deploySpokePoolWithToken(originChainId);

    const searchConfig: EventSearchConfig | undefined = undefined;
    spokePoolClient = new MockSpokeListener(logger, spokePool, null, originChainId, deploymentBlock, searchConfig);
    spokePoolClient.init({});
    blockNumber = 1_000;
  });

  it("Records the arrival delay for blocks observed live", async function () {
    const arrivalDelay = 10;
    postBlock(blockNumber, getCurrentTime() - arrivalDelay);
    expect(spokePoolClient.getBlockArrivalDelay(blockNumber)).to.be.at.least(arrivalDelay);
  });

  it("Records no arrival delay for blocks that were not observed live", async function () {
    postBlock(blockNumber, getCurrentTime());
    expect(spokePoolClient.getBlockArrivalDelay(blockNumber - 1)).to.be.undefined;
  });

  it("Records no arrival delay for polled block updates", async function () {
    // A polled update (the EVM startup scrape, the TVM head poll) carries no observation time: the interval
    // between the block's timestamp and the poll measures poll phase, not how late the block was published.
    postBlock(blockNumber, getCurrentTime() - 60, null);
    expect(spokePoolClient.getBlockArrivalDelay(blockNumber)).to.be.undefined;
  });

  it("Measures the arrival delay from the listener's observation, not message receipt", async function () {
    // The listener saw the block promptly, but only posted it after a slow backfill. The delay in transmission
    // is not arrival delay.
    const currentTime = getCurrentTime() - 60;
    postBlock(blockNumber, currentTime, currentTime);
    expect(spokePoolClient.getBlockArrivalDelay(blockNumber)).to.equal(0);
  });

  it("Records the arrival delay for a same-height replacement block", async function () {
    const currentTime = getCurrentTime();
    postBlock(blockNumber, currentTime);
    expect(spokePoolClient.getBlockArrivalDelay(blockNumber)).to.be.below(maxDelay);

    // A same-height replacement takes the misordered-block path, but is exactly what the gate exists to catch.
    spokePoolClient.isUpdated = true;
    postBlock(blockNumber, currentTime - 30);
    expect(spokePoolClient.getBlockArrivalDelay(blockNumber)).to.be.at.least(30);
  });

  it("Never lowers a height's recorded arrival delay", async function () {
    const currentTime = getCurrentTime();
    postBlock(blockNumber, currentTime - 30);
    expect(spokePoolClient.getBlockArrivalDelay(blockNumber)).to.be.at.least(30);

    spokePoolClient.isUpdated = true;
    postBlock(blockNumber, currentTime);
    expect(spokePoolClient.getBlockArrivalDelay(blockNumber)).to.be.at.least(30);
  });

  it("Evicts arrival delays beyond the retention window", async function () {
    const currentTime = getCurrentTime();
    postBlock(blockNumber, currentTime);
    expect(spokePoolClient.getBlockArrivalDelay(blockNumber)).to.exist;

    // The oldest retained block is exactly BLOCK_ARRIVAL_HISTORY behind the most recent one.
    postBlock(blockNumber + BLOCK_ARRIVAL_HISTORY, currentTime + 1);
    expect(spokePoolClient.getBlockArrivalDelay(blockNumber)).to.exist;

    postBlock(blockNumber + BLOCK_ARRIVAL_HISTORY + 1, currentTime + 2);
    expect(spokePoolClient.getBlockArrivalDelay(blockNumber)).to.be.undefined;
  });

  it("Reports the margin remaining when a removal lands for a block still being held", async function () {
    const txnRef = randomAddress();
    postBlock(blockNumber, getCurrentTime() - 30); // Arrived late, so the gate would be holding it.
    spokePoolClient.depositHashes = { relayHash: { blockNumber, txnRef } };
    spokePoolClient.latestHeightSearched = blockNumber + 1;

    postRemoval(blockNumber, txnRef);
    await spokePoolClient._update([]);

    const toSpare = LATE_BLOCK_MIN_CONFIRMATIONS - 1;
    expect(lastSpyLogIncludes(spy, `${toSpare} confirmation(s) to spare`)).to.be.true;
  });

  it("Reports a removal that lands after the gate has already released", async function () {
    const txnRef = randomAddress();
    postBlock(blockNumber, getCurrentTime() - 30);
    spokePoolClient.depositHashes = { relayHash: { blockNumber, txnRef } };
    spokePoolClient.latestHeightSearched = blockNumber + LATE_BLOCK_MIN_CONFIRMATIONS;

    postRemoval(blockNumber, txnRef);
    await spokePoolClient._update([]);

    expect(lastSpyLogIncludes(spy, "after the gate had already released")).to.be.true;
  });

  it("Withholds a deposit sourced from a late-arriving origin block until it is confirmed", async function () {
    const relayer = makeRelayer({ maxOriginBlockArrivalDelay: { [originChainId]: maxDelay } });
    postBlock(blockNumber, getCurrentTime() - maxDelay);
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
    const relayer = makeRelayer({ maxOriginBlockArrivalDelay: { [originChainId]: maxDelay } });
    postBlock(blockNumber, getCurrentTime());

    spokePoolClient.latestHeightSearched = blockNumber;
    expect(relayer.originBlockUnsettled(makeDeposit(blockNumber))).to.be.false;
  });

  it("Does not withhold a deposit whose origin block was not observed live", async function () {
    const relayer = makeRelayer({ maxOriginBlockArrivalDelay: { [originChainId]: maxDelay } });
    postBlock(blockNumber, getCurrentTime() - maxDelay);

    // Nothing was recorded for the preceding block, so it can't be known to be late.
    spokePoolClient.latestHeightSearched = blockNumber;
    expect(relayer.originBlockUnsettled(makeDeposit(blockNumber - 1))).to.be.false;
  });

  it("Does not withhold when the origin chain threshold is zero", async function () {
    const relayer = makeRelayer({ maxOriginBlockArrivalDelay: { [originChainId]: 0 } });
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

describe("RelayerConfig: Late-arriving origin block threshold", function () {
  const chainId = CHAIN_IDs.MAINNET;
  const svmChainId = CHAIN_IDs.SOLANA;
  const envKey = (chainId: number) => `RELAYER_MAX_ORIGIN_BLOCK_ARRIVAL_DELAY_${chainId}`;

  let logger: winston.Logger;
  let saved: { [key: string]: string | undefined };

  beforeEach(function () {
    ({ spyLogger: logger } = createSpyLogger());
    saved = Object.fromEntries([chainId, svmChainId].map((chainId) => [envKey(chainId), process.env[envKey(chainId)]]));
  });

  afterEach(function () {
    Object.entries(saved).forEach(([key, value]) => {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    });
  });

  const validate = (chainIds: number[], env: ProcessEnv = {}): RelayerConfig => {
    const chains = JSON.stringify(chainIds);
    const config = new RelayerConfig({
      RELAYER_ORIGIN_CHAINS: chains,
      RELAYER_DESTINATION_CHAINS: chains,
      RELAYER_EXTERNAL_LISTENER: "true",
      ...env,
    });
    config.validate(chainIds, logger);
    return config;
  };

  it("Defaults to disabled", function () {
    delete process.env[envKey(chainId)];
    expect(validate([chainId]).maxOriginBlockArrivalDelay[chainId]).to.equal(0);
  });

  it("Accepts a positive threshold", function () {
    process.env[envKey(chainId)] = "6";
    expect(validate([chainId]).maxOriginBlockArrivalDelay[chainId]).to.equal(6);
  });

  it("Rejects a malformed threshold", function () {
    process.env[envKey(chainId)] = "oops";
    expect(() => validate([chainId])).to.throw(/Invalid max origin block arrival delay/);
  });

  it("Rejects a negative threshold", function () {
    process.env[envKey(chainId)] = "-1";
    expect(() => validate([chainId])).to.throw(/Invalid max origin block arrival delay/);
  });

  it("Rejects a threshold on an SVM chain, where the arrival delay is not observable", function () {
    process.env[envKey(svmChainId)] = "6";
    expect(() => validate([svmChainId])).to.throw(/unsupported on chain/);
  });

  it("Accepts a threshold without the external listener, leaving it inert", function () {
    process.env[envKey(chainId)] = "6";
    const config = validate([chainId], { RELAYER_EXTERNAL_LISTENER: "false" });
    expect(config.externalListener).to.be.false;
    expect(config.maxOriginBlockArrivalDelay[chainId]).to.equal(6);
  });
});
