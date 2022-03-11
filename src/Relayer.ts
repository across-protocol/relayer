import { BigNumber, winston } from "./utils";
import { SpokePoolEventClient } from "./SpokePoolEventClient";
import { MulticallBundler } from "./MulticallBundler";
import { Deposit } from "./interfaces/SpokePool";

export class Relayer {
  constructor(
    readonly logger: winston.Logger,
    readonly spokePoolEventClients: { [chainId: number]: SpokePoolEventClient },
    readonly multicallBundler: MulticallBundler | any
  ) {}
  checkForRelayableRelaysAndRelay() {}

  // Returns all unfilled deposits over all spokePoolClients. Return values include the amount of the unfilled deposit.
  getUnfilledDeposits() {
    let unfilledDeposits: { unfilledAmount: BigNumber; deposit: Deposit }[] = [];
    // Iterate over each chainId and check for unfilled deposits.
    const chainIds = Object.keys(this.spokePoolEventClients);
    for (const originChain of chainIds) {
      const originClient = this.spokePoolEventClients[originChain];
      for (const destinationChain of chainIds) {
        if (originChain === destinationChain) continue;
        const destinationClient = this.spokePoolEventClients[destinationChain];
        const depositsForDestinationChain = originClient.getDepositsForDestinationChain(destinationChain);
        unfilledDeposits.push(
          ...depositsForDestinationChain // append all deposits for the current destination chain that are unfilled.
            .map((deposit) => {
              return { unfilledAmount: destinationClient.getUnfilledAmountForDeposit(deposit), deposit };
            }) // remove any deposits that have no unfilled amount (i.e that are 100% filled).
            .filter((deposit) => deposit.unfilledAmount.gt(0))
        );
      }
    }
    return unfilledDeposits;
  }
}
