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

  it("falls back to defaults on unparseable numeric env", function () {
    const config = new DepositAddressServiceConfig({ PORT: "not-a-port", APPLICATION_DEADLINE_MS: "-5" });
    expect(config.port).to.equal(8080);
    expect(config.applicationDeadlineMs).to.equal(480_000);
  });

  it("rejects an application deadline at or past the Cloud Run request timeout", function () {
    // Past 540s Cloud Run gives up first, so the deadline would guarantee nothing.
    for (const value of ["540000", "600000"]) {
      expect(() => new DepositAddressServiceConfig({ APPLICATION_DEADLINE_MS: value }), value).to.throw(
        /must be below the Cloud Run request timeout/
      );
    }
    expect(new DepositAddressServiceConfig({ APPLICATION_DEADLINE_MS: "539000" }).applicationDeadlineMs).to.equal(
      539_000
    );
  });

  it("keeps the drain timeout inside Cloud Run's SIGKILL grace period", function () {
    // Cloud Run SIGKILLs 10s after SIGTERM, so a longer drain is killed before it can finish.
    expect(new DepositAddressServiceConfig({}).shutdownDrainTimeoutMs).to.equal(8_000);
    expect(() => new DepositAddressServiceConfig({ SHUTDOWN_DRAIN_TIMEOUT_MS: "25000" })).to.throw(
      /exceeds Cloud Run's SIGKILL grace period/
    );
  });
});
