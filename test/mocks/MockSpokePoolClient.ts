import { SpokePoolClient } from "../../src/clients";

export class MockedSpokePoolClient extends SpokePoolClient {
  // Each index in the array is assumed to be a block number, with the mocked deposit ID at the block heigh
  // as the value.
  public depositIds: number[] = [];

  setDepositIds(_depositIds: number[]) {
    this.depositIds = [];
    console.log(_depositIds);
    if (_depositIds.length === 0) return;
    let lastDepositId = _depositIds[0];
    for (let i = 0; i < _depositIds.length; i++) {
      if (_depositIds[i] < lastDepositId) throw new Error("deposit ID must be equal to or greater than previous");
      this.depositIds[i] = _depositIds[i];
      lastDepositId = _depositIds[i];
    }
  }

  async _getDepositIdAtBlock(blockTag: number): Promise<number> {
    return this.depositIds[blockTag];
  }
}
