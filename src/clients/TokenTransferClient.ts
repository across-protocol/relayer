import {
  EventSearchConfig,
  winston,
  assign,
  ERC20,
  Contract,
  paginatedEventQuery,
  spreadEventWithBlockNumber,
} from "../utils";
import { Log, TokenTransfer, TransfersByChain } from "../interfaces";
import { Provider } from "@ethersproject/abstract-provider";

export class TokenTransferClient {
  private tokenTransfersByAddress: { [address: string]: TransfersByChain } = {};

  constructor(
    readonly logger: winston.Logger,
    // We can accept spokePoolClients here instead, but just accepting providers makes it very clear that we dont
    // rely on SpokePoolClient and its cached state.
    readonly providerByChainIds: { [chainId: number]: Provider },
    readonly monitoredAddresses: string[]
  ) {}

  getTokenTransfers(address: string): TransfersByChain {
    return this.tokenTransfersByAddress[address];
  }

  async update(
    searchConfigByChainIds: { [chainId: number]: EventSearchConfig },
    tokenByChainIds: { [chainId: number]: string[] }
  ): Promise<void> {
    this.logger.debug({
      at: "TokenTransferClient",
      message: "Updating TokenTransferClient client",
      searchConfigByChainIds,
      tokenByChainIds,
    });
    const tokenContractsByChainId = Object.fromEntries(
      Object.entries(tokenByChainIds).map(([chainId, tokens]) => [
        Number(chainId),
        tokens.map((token: string) => new Contract(token, ERC20.abi, this.providerByChainIds[Number(chainId)])),
      ])
    );

    const chainIds = Object.keys(this.providerByChainIds).map(Number);
    for (const chainId of chainIds) {
      const tokenContracts = tokenContractsByChainId[chainId];
      for (const monitoredAddress of this.monitoredAddresses) {
        const transferEventsList = await Promise.all(
          tokenContracts.map((tokenContract) =>
            this.querySendAndReceiveEvents(tokenContract, monitoredAddress, searchConfigByChainIds[chainId])
          )
        );
        const transferEventsPerToken: { [tokenAddress: string]: Log[][] } = Object.fromEntries(
          transferEventsList.map((transferEvents, i) => [tokenContracts[i].address, transferEvents])
        );

        // Create an entry in the cache if not initialized.
        const tokenTransfers = this.tokenTransfersByAddress[monitoredAddress];
        if (tokenTransfers === undefined || tokenTransfers[chainId] === undefined) {
          assign(this.tokenTransfersByAddress, [monitoredAddress, chainId], {});
        }

        // Update outgoing and incoming transfers for current relayer in the cache.
        const transferCache = this.tokenTransfersByAddress[monitoredAddress][chainId];
        for (const [tokenAddress, events] of Object.entries(transferEventsPerToken)) {
          if (transferCache[tokenAddress] === undefined) {
            transferCache[tokenAddress] = {
              incoming: [],
              outgoing: [],
            };
          }

          for (const event of events[0]) {
            const outgoingTransfer = spreadEventWithBlockNumber(event) as TokenTransfer;
            transferCache[tokenAddress].outgoing.push(outgoingTransfer);
          }

          for (const event of events[1]) {
            const incomingTransfer = spreadEventWithBlockNumber(event) as TokenTransfer;
            transferCache[tokenAddress].incoming.push(incomingTransfer);
          }
        }
      }
    }

    this.logger.debug({ at: "TokenTransferClient", message: "TokenTransfer client updated!" });
  }

  // Returns outgoing and incoming transfers for the specified tokenContract and address.
  querySendAndReceiveEvents(tokenContract: Contract, address: string, config: EventSearchConfig): Promise<Log[][]> {
    const eventFilters = [[address], [undefined, address]];
    return Promise.all(
      eventFilters.map((eventFilter) =>
        paginatedEventQuery(tokenContract, tokenContract.filters.Transfer(...eventFilter), config)
      )
    );
  }
}
