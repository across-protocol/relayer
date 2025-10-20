/* eslint-disable @typescript-eslint/no-explicit-any */
import { task } from "hardhat/config";
import { getSigner, winston } from "../src/utils";
import { SpyTransport, bigNumberFormatter } from "@uma/logger";
import { runDataworker } from "../src/dataworker";
import { runRelayer } from "../src/relayer";
import { runFinalizer } from "../src/finalizer";
import sinon from "sinon";

// Redefine create spy logger here so we can test log contents without having to import from ../test/utils
// which causes errors because of some unknown interaction between hardhat task runner and that folder.
export function createSpyLogger(): {
  spy: sinon.SinonSpy<any[], any>;
  spyLogger: winston.Logger;
} {
  const spy = sinon.spy();
  const transports: winston.transport[] = [new SpyTransport({ level: "debug" }, { spy })];
  if (process.env.LOG_IN_TEST) {
    transports.push(new winston.transports.Console());
  }

  const spyLogger = winston.createLogger({
    level: "debug",
    format: winston.format.combine(winston.format(bigNumberFormatter)(), winston.format.json()),
    transports,
  });

  return { spy, spyLogger };
}

task("integration-tests", "Run integration tests against key Dataworker functions")
  .addOptionalParam("mnemonic", "Derives signer from MNEMONIC environment variable if wallet=mnemonic")
  .addOptionalParam("wallet", "User can specify 'gckms' or 'mnemonic'")
  .addOptionalParam("keys", "Indicates which gckms bot to use if wallet=gckms")
  .setAction(async function () {
    const { spyLogger } = createSpyLogger();

    // Override environment variables that we want to control for, for example we want to prevent the runner of this
    // script from sending any on-chain transactions.
    process.env.POLLING_DELAY = "0"; // Set to serverless mode so that bot terminates after successful run.
    process.env.DISPUTER_ENABLED = "true";
    process.env.PROPOSER_ENABLED = "true";
    process.env.EXECUTOR_ENABLED = "true";
    process.env.SEND_EXECUTIONS = "false";
    process.env.SEND_PROPOSALS = "false";
    process.env.SEND_DISPUTES = "false";
    process.env.SEND_RELAYS = "false";
    process.env.FINALIZER_ENABLED = "false";

    // TODO: Add ability to run finalizer in simulation mode, currently it will construct all finalizer clients but
    // skips the finalize() function entirely if FINALIZER_ENABLED!=="true"

    // Run dataworker, should not throw:
    let start = Date.now();
    console.log("🐙 Testing Dataworker functions...");
    await runDataworker(spyLogger, await getSigner());
    console.log(`...Done in ${(Date.now() - start) / 1000}s`);

    // Run relayer, should not throw
    start = Date.now();
    console.log("🦌 Testing Relayer functions...");
    await runRelayer(spyLogger, await getSigner());
    console.log(`...Done in ${(Date.now() - start) / 1000}s`);

    // Run finalizer, should not throw
    start = Date.now();
    console.log("🏧 Testing Finalizer functions...");
    await runFinalizer(spyLogger, await getSigner());
    console.log(`...Done in ${(Date.now() - start) / 1000}s`);
  });
