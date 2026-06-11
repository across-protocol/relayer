import { CHAIN_IDs, TOKEN_SYMBOLS_MAP } from "@across-protocol/constants";
import { CrossChainTransferClient } from "../src/clients/bridges";
import { EvmAddress, bnZero } from "../src/utils";
import { OutstandingTransfers } from "../src/interfaces";
import { MockAdapterManager } from "./mocks";
import { createSpyLogger, expect, toBNWei } from "./utils";

const { OPTIMISM, ARBITRUM, BASE } = CHAIN_IDs;
const HOLDER = EvmAddress.from("0x1000000000000000000000000000000000000001");
const usdc = EvmAddress.from(TOKEN_SYMBOLS_MAP.USDC.addresses[CHAIN_IDs.MAINNET]);

describe("CrossChainTransferClient: update isolation", function () {
  it("isolates per-chain failures and preserves stale state on the failing chain", async function () {
    const { spy, spyLogger } = createSpyLogger();
    const adapterManager = new MockAdapterManager(null, null, null, null);
    adapterManager.getOutstandingCrossChainTransfers = async (chainId: number): Promise<OutstandingTransfers> => {
      if (chainId === ARBITRUM) {
        throw new Error("503 Service Unavailable");
      }
      return {
        [HOLDER.toNative()]: {
          [usdc.toNative()]: {
            [usdc.toNative()]: { totalAmount: toBNWei("1", 6), depositTxHashes: [`hash-${chainId}`] },
          },
        },
      };
    };

    const client = new CrossChainTransferClient(spyLogger, [OPTIMISM, ARBITRUM, BASE], adapterManager);
    client["outstandingCrossChainTransfers"] = {
      [ARBITRUM]: {
        [HOLDER.toNative()]: {
          [usdc.toNative()]: {
            [usdc.toNative()]: { totalAmount: toBNWei("9", 6), depositTxHashes: ["stale"] },
          },
        },
      },
    };

    await client.update([usdc]);

    expect(client.getOutstandingCrossChainTransferAmount(HOLDER, OPTIMISM, usdc)).to.equal(toBNWei("1", 6));
    expect(client.getOutstandingCrossChainTransferAmount(HOLDER, BASE, usdc)).to.equal(toBNWei("1", 6));
    expect(client.getOutstandingCrossChainTransferAmount(HOLDER, ARBITRUM, usdc)).to.equal(toBNWei("9", 6));
    expect(
      spy
        .getCalls()
        .some(
          (c) =>
            c.lastArg?.level === "error" &&
            String(c.lastArg?.message ?? "").includes(`outstanding cross chain transfers for chain ${ARBITRUM}`)
        ),
      "expected error log for the failing chain"
    ).to.be.true;
  });

  it("does not throw when every chain's adapter rejects", async function () {
    const { spyLogger } = createSpyLogger();
    const adapterManager = new MockAdapterManager(null, null, null, null);
    adapterManager.getOutstandingCrossChainTransfers = async () => {
      throw new Error("503 Service Unavailable");
    };

    const client = new CrossChainTransferClient(spyLogger, [OPTIMISM, ARBITRUM], adapterManager);
    await client.update([usdc]); // would throw if rejection escaped Promise.allSettled
    expect(client.getOutstandingCrossChainTransferAmount(HOLDER, OPTIMISM, usdc)).to.equal(bnZero);
  });
});
