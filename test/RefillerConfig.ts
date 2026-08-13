import { expect } from "chai";
import { CHAIN_IDs, getNativeTokenAddressForChain } from "../src/utils";
import { RefillerConfig } from "../src/refiller/RefillerConfig";

const ACCOUNT = "0x1111111111111111111111111111111111111111";
const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

describe("RefillerConfig REFILL_BALANCES_2", function () {
  it("accepts a single object per account/chain", function () {
    const config = new RefillerConfig({
      REFILL_BALANCES_2: JSON.stringify({
        [ACCOUNT]: {
          [CHAIN_IDs.BASE]: { target: 0.05, trigger: 0.02 },
        },
      }),
    });
    expect(config.refillEnabledBalances).to.have.length(1);
    expect(config.refillEnabledBalances[0].chainId).to.equal(CHAIN_IDs.BASE);
    expect(config.refillEnabledBalances[0].target).to.equal(0.05);
    expect(config.refillEnabledBalances[0].token.toEvmAddress().toLowerCase()).to.equal(
      getNativeTokenAddressForChain(CHAIN_IDs.BASE).toEvmAddress().toLowerCase()
    );
  });

  it("accepts an array of objects per account/chain", function () {
    const config = new RefillerConfig({
      REFILL_BALANCES_2: JSON.stringify({
        [ACCOUNT]: {
          [CHAIN_IDs.BASE]: [
            { target: 0.05, trigger: 0.02 },
            { target: 1000, trigger: 500, token: USDC_BASE },
          ],
        },
      }),
    });
    expect(config.refillEnabledBalances).to.have.length(2);
    expect(config.refillEnabledBalances[0].token.toEvmAddress().toLowerCase()).to.equal(
      getNativeTokenAddressForChain(CHAIN_IDs.BASE).toEvmAddress().toLowerCase()
    );
    expect(config.refillEnabledBalances[1].token.toEvmAddress().toLowerCase()).to.equal(USDC_BASE.toLowerCase());
    expect(config.refillEnabledBalances[1].target).to.equal(1000);
  });
});
