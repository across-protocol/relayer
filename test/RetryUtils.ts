import { assertPromiseError, expect } from "./utils";

// Tested
import { delay, retryAsync } from "../src/utils";

const expectedErrorMsg = "async error";
const expectedReturnValue = 1;

let ERROR_COUNTER = 0;

// This function will throw based on the value of an external counter variable, this way
// we can use it to test a function that fails intermittently. If `errorIndex` is >
// to ERROR_COUNTER, then `expectedErrorMsg` will be thrown.
async function incrementCounterThrowError(errorIndex: number, returnValue = expectedReturnValue): Promise<number> {
  const oldCounter = ERROR_COUNTER;
  ERROR_COUNTER++;
  await delay(0);
  if (errorIndex > oldCounter) {
    throw new Error(expectedErrorMsg);
  } else {
    return Promise.resolve(returnValue);
  }
}

describe("RetryUtils", async function () {
  beforeEach(async function () {
    ERROR_COUNTER = 0;
  });
  it("retryAsync", async function () {
    // Succeeds first time, runs one loop.
    expect(await retryAsync(() => incrementCounterThrowError(ERROR_COUNTER), 3, 1)).to.equal(expectedReturnValue);
    expect(ERROR_COUNTER).to.equal(1);

    // Fails every time, should throw error, runs four loops, one for first try, and then three retries.
    await assertPromiseError(
      retryAsync(() => incrementCounterThrowError(ERROR_COUNTER + 1), 3, 1),
      expectedErrorMsg
    );
    expect(ERROR_COUNTER).to.equal(5);

    // Fails first time only, runs two loops, one for first failure, and then retries
    // successfully:
    const errorCounter = ERROR_COUNTER;
    expect(await retryAsync(() => incrementCounterThrowError(errorCounter + 1), 3, 1)).to.equal(expectedReturnValue);
    expect(ERROR_COUNTER).to.equal(7);

    // Delays 1s per retry, retries three times for four more iterations.
    const timerStart = performance.now();
    await assertPromiseError(
      retryAsync(() => incrementCounterThrowError(ERROR_COUNTER + 1), 3, 1),
      expectedErrorMsg
    );
    expect(ERROR_COUNTER).to.equal(11);
    expect(performance.now() - timerStart).to.be.greaterThan(3000);
  });
});
