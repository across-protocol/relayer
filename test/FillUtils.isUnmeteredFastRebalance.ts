import { expect } from "chai";
import { CHAIN_IDs, TOKEN_SYMBOLS_MAP } from "@across-protocol/constants";
import { toAddressType } from "../src/utils";
import { isUnmeteredFastRebalance } from "../src/utils/FillUtils";

const { MAINNET, ROBINHOOD } = CHAIN_IDs;

describe("FillUtils.isUnmeteredFastRebalance", function () {
  const usdgOnRobinhood = toAddressType(TOKEN_SYMBOLS_MAP.USDG.addresses[ROBINHOOD], ROBINHOOD);
  const wethOnRobinhood = toAddressType(TOKEN_SYMBOLS_MAP.WETH.addresses[ROBINHOOD], ROBINHOOD);

  it("treats a Paxos Transit route as unmetered", function () {
    expect(isUnmeteredFastRebalance(ROBINHOOD, usdgOnRobinhood, MAINNET)).to.be.true;
  });

  it("does not extend to tokens without a Paxos Transit route", function () {
    expect(isUnmeteredFastRebalance(ROBINHOOD, wethOnRobinhood, MAINNET)).to.be.false;
  });
});
