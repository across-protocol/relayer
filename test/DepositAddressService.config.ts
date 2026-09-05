import { expect } from "./utils";
import { DepositAddressServiceConfig } from "../src/deposit-address-service/config";

describe("DepositAddressServiceConfig", function () {
  it("defaults execution off, so a build cannot act before its paths are reviewed", function () {
    expect(new DepositAddressServiceConfig({}).executionEnabled).to.equal(false);
    expect(new DepositAddressServiceConfig({ EXECUTION_ENABLED: "TRUE" }).executionEnabled).to.equal(false);
    expect(new DepositAddressServiceConfig({ EXECUTION_ENABLED: "true" }).executionEnabled).to.equal(true);
  });

  it("keeps the application deadline inside the Cloud Run request timeout", function () {
    // 480s application deadline < 540s Cloud Run timeout < 600s lock TTL. The application deadline is
    // the enforceable one, because a Cloud Run 504 does not stop handler code.
    expect(new DepositAddressServiceConfig({}).applicationDeadlineMs).to.equal(480_000);
  });

  it("defaults on an absent or empty value", function () {
    for (const env of [{}, { PORT: "", APPLICATION_DEADLINE_MS: "  " }]) {
      const config = new DepositAddressServiceConfig(env);
      expect(config.port).to.equal(8080);
      expect(config.applicationDeadlineMs).to.equal(480_000);
    }
  });

  it("fails startup on a present-but-invalid value rather than silently defaulting", function () {
    // Same class of bug as an unvalidated body limit: running with something other than what was
    // configured is far harder to diagnose than refusing to start.
    for (const env of [
      { PORT: "not-a-port" },
      { PORT: "0" },
      { PORT: "65536" },
      { APPLICATION_DEADLINE_MS: "-5" },
      { APPLICATION_DEADLINE_MS: "1.5" },
      { SHUTDOWN_DRAIN_TIMEOUT_MS: "abc" },
    ]) {
      expect(() => new DepositAddressServiceConfig(env), JSON.stringify(env)).to.throw(/must be a positive integer/);
    }
  });

  it("rejects an application deadline at or past the Cloud Run request timeout", function () {
    // Past 540s Cloud Run gives up first, so the deadline would guarantee nothing.
    for (const value of ["540000", "600000"]) {
      expect(() => new DepositAddressServiceConfig({ APPLICATION_DEADLINE_MS: value }), value).to.throw(
        /APPLICATION_DEADLINE_MS/
      );
    }
    expect(new DepositAddressServiceConfig({ APPLICATION_DEADLINE_MS: "539000" }).applicationDeadlineMs).to.equal(
      539_000
    );
  });

  it("refuses a withdraw-publisher gate with nothing behind it", function () {
    // A settled withdrawal has no on-chain provenance event, so an enabled-but-unwired publisher is only
    // discovered when a refund goes unannounced. Off, the two are irrelevant and unvalidated.
    expect(new DepositAddressServiceConfig({}).withdrawPublisherEnabled).to.equal(false);
    for (const env of [
      { ENABLE_DEPOSIT_ADDRESS_WITHDRAW_PUBLISHER: "true" },
      { ENABLE_DEPOSIT_ADDRESS_WITHDRAW_PUBLISHER: "true", PUBSUB_GCP_PROJECT_ID: "p" },
      { ENABLE_DEPOSIT_ADDRESS_WITHDRAW_PUBLISHER: "true", PUBSUB_DEPOSIT_ADDRESS_WITHDRAW_TOPIC: "t" },
    ]) {
      expect(() => new DepositAddressServiceConfig(env), JSON.stringify(env)).to.throw(/is required when/);
    }

    const config = new DepositAddressServiceConfig({
      ENABLE_DEPOSIT_ADDRESS_WITHDRAW_PUBLISHER: "true",
      PUBSUB_GCP_PROJECT_ID: "p",
      PUBSUB_DEPOSIT_ADDRESS_WITHDRAW_TOPIC: "t",
    });
    expect(config.pubSubWithdrawTopic).to.equal("t");
  });

  it("requires the drain timeout strictly below Cloud Run's SIGKILL grace period", function () {
    // A drain running until the SIGKILL instant races the kill, so 10s is as useless as 25s.
    expect(new DepositAddressServiceConfig({}).shutdownDrainTimeoutMs).to.equal(8_000);
    expect(new DepositAddressServiceConfig({ SHUTDOWN_DRAIN_TIMEOUT_MS: "9999" }).shutdownDrainTimeoutMs).to.equal(
      9_999
    );
    for (const value of ["10000", "25000"]) {
      expect(() => new DepositAddressServiceConfig({ SHUTDOWN_DRAIN_TIMEOUT_MS: value }), value).to.throw(
        /SHUTDOWN_DRAIN_TIMEOUT_MS/
      );
    }
  });
});
