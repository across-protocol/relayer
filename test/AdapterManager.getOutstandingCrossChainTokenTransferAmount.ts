import { TransactionResponse } from "@ethersproject/abstract-provider";
import { SpokePoolClient } from "../src/clients";
import { BaseAdapter, DepositEvent } from "../src/clients/bridges";
import { OutstandingTransfers } from "../src/interfaces";
import { createSpyLogger, expect, toBN } from "./utils";

class TestAdapter extends BaseAdapter {
  constructor() {
    super(
      {
        1: { latestBlockNumber: 123 } as unknown as SpokePoolClient,
      },
      1,
      ["0xmonitored"],
      createSpyLogger().spyLogger,
      []
    );
  }

  public setDepositEvents(amounts: number[]) {
    const deposits = amounts.map((amount) => {
      return { amount: toBN(amount) };
    });
    this.l1DepositInitiatedEvents = { "0xmonitored": { token: deposits as unknown as DepositEvent[] } };
  }

  public setFinalizationEvents(amounts: number[]) {
    const deposits = amounts.map((amount) => {
      return { amount: toBN(amount) };
    });
    this.l2DepositFinalizedEvents = { "0xmonitored": { token: deposits as unknown as DepositEvent[] } };
  }

  getOutstandingCrossChainTransfers(): Promise<OutstandingTransfers> {
    throw new Error("This Test Adapter has not implemented this FN.");
  }
  sendTokenToTargetChain(): Promise<TransactionResponse> {
    throw new Error("This Test Adapter has not implemented this FN.");
  }
  checkTokenApprovals(): Promise<void> {
    throw new Error("This Test Adapter has not implemented this FN.");
  }
  wrapEthIfAboveThreshold(): Promise<TransactionResponse> {
    throw new Error("This Test Adapter has not implemented this FN.");
  }
}

let adapter: TestAdapter;
describe("AdapterManager: Get outstanding cross chain token transfer amounts", function () {
  beforeEach(function () {
    adapter = new TestAdapter();
  });

  it("Deposits and finalizations perfectly match", () => {
    // Perfectly match.
    adapter.setDepositEvents([1, 2, 3]);
    adapter.setFinalizationEvents([1, 2, 3]);
    expectOutstandingTransfersAmount(adapter.computeOutstandingCrossChainTransfers(["token"]), 0);

    // Perfectly match but with some disorder.
    adapter.setDepositEvents([1, 2, 3]);
    adapter.setFinalizationEvents([2, 1, 3]);
    expectOutstandingTransfersAmount(adapter.computeOutstandingCrossChainTransfers(["token"]), 0);

    // Latest deposit not finalized.
    adapter.setDepositEvents([1, 2, 3]);
    adapter.setFinalizationEvents([2, 1]);
    expectOutstandingTransfersAmount(adapter.computeOutstandingCrossChainTransfers(["token"]), 3);

    // Older deposit not finalized.
    adapter.setDepositEvents([1, 2, 3]);
    adapter.setFinalizationEvents([3, 1]);
    expectOutstandingTransfersAmount(adapter.computeOutstandingCrossChainTransfers(["token"]), 2);

    // Collision by amount.
    adapter.setDepositEvents([1, 3, 1]);
    adapter.setFinalizationEvents([3, 1]);
    expectOutstandingTransfersAmount(adapter.computeOutstandingCrossChainTransfers(["token"]), 1);
  });
});

const expectOutstandingTransfersAmount = (transfers: OutstandingTransfers, amount: number) => {
  const actualAmount = transfers["0xmonitored"]?.["token"]?.totalAmount || toBN(0);
  expect(actualAmount).to.eq(toBN(amount));
};
