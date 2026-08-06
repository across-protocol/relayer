import { expect } from "chai";
import { CHAIN_IDs, TOKEN_SYMBOLS_MAP } from "@across-protocol/constants";
import { toAddressType } from "../src/utils";
import { isUnmeteredFastRebalance } from "../src/utils/FillUtils";

const { MAINNET, ROBINHOOD } = CHAIN_IDs;

describe("FillUtils.isUnmeteredFastRebalance", function () {
  const usdgOnRobinhood = toAddressType(TOKEN_SYMBOLS_MAP.USDG.addresses[ROBINHOOD], ROBINHOOD);
  const wethOnRobinhood = toAddressType(TOKEN_SYMBOLS_MAP.WETH.addresses[ROBINHOOD], ROBINHOOD);
  let priorApiKey: string | undefined;

  beforeEach(function () {
    priorApiKey = process.env.PAXOS_API_KEY;
  });

  afterEach(function () {
    if (priorApiKey === undefined) {
      delete process.env.PAXOS_API_KEY;
    } else {
      process.env.PAXOS_API_KEY = priorApiKey;
    }
  });

  it("treats a Paxos Transit route as unmetered when credentials are configured", function () {
    process.env.PAXOS_API_KEY = "test-key";
    expect(isUnmeteredFastRebalance(ROBINHOOD, usdgOnRobinhood, MAINNET)).to.be.true;
  });

  it("fails closed without PAXOS_API_KEY", function () {
    delete process.env.PAXOS_API_KEY;
    expect(isUnmeteredFastRebalance(ROBINHOOD, usdgOnRobinhood, MAINNET)).to.be.false;
  });

  it("does not extend to tokens without a Paxos Transit route", function () {
    process.env.PAXOS_API_KEY = "test-key";
    expect(isUnmeteredFastRebalance(ROBINHOOD, wethOnRobinhood, MAINNET)).to.be.false;
  });
});
