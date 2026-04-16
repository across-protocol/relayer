import assert from "assert";
import { EventEmitter } from "node:events";
import { AbiEvent, BaseError, Block, createPublicClient, http, Log as viemLog, parseAbiItem, webSocket } from "viem";
import { Log } from "../interfaces";
import {
  EventManager,
  getNetworkName,
  getNodeUrlList,
  getOriginFromURL,
  getProviderHeaders,
  getViemChain,
  winston,
} from "../utils";

function resolveProviders(chainId: number, quorum = 1) {
  const protocol = process.env[`RPC_PROVIDERS_TRANSPORT_${chainId}`] ?? "wss";
  assert(protocol === "wss" || protocol === "https");

  const urls = Object.values(getNodeUrlList(chainId, quorum, protocol));
  const nProviders = urls.length;
  const chain = getNetworkName(chainId);
  assert(nProviders >= quorum, `Insufficient providers for ${chain} (minimum ${quorum} required by quorum)`);

  const viemChain = getViemChain(chainId);
  const providers = Object.entries(urls).map(([provider, url]) => {
    const headers = getProviderHeaders(provider, chainId);
    const transport = protocol === "wss" ? webSocket(url) : http(url, { fetchOptions: { headers } });

    return createPublicClient({
      chain: viemChain,
      transport,
      name: getOriginFromURL(url),
    });
  });

  return providers;
}

export class EventListener extends EventEmitter {
  public readonly chain: string;
  protected readonly eventMgr: EventManager;
  private readonly providers: ReturnType<typeof resolveProviders>;
  protected readonly blocks: Map<bigint, string> = new Map();
  // private readonly abortController: AbortController;

  constructor(
    public readonly chainId: number,
    private readonly logger: winston.Logger,
    public readonly quorum = 1
  ) {
    super();
    this.chain = getNetworkName(chainId);
    // this.abortController = new AbortController();
    this.eventMgr = new EventManager(logger, chainId, quorum);
    this.providers = resolveProviders(chainId, quorum);
  }

  onBlock(handler: (blockNumber: number, timestamp: number) => void) {
    const at = "EventListener::onBlock";
    const { chain, logger } = this;

    const newBlock = (block: Block, provider: string) => {
      // Transient error that sometimes occurs. Catch it here and try to flush out the provider.
      if (!block || block.hash === null) {
        logger.debug({ at, message: `Received empty ${chain} block from ${provider}.` });
        return;
      }

      // Detect re-orgs via parent hash continuity.
      const expectedParentHash = this.blocks.get(block.number - 1n);
      if (expectedParentHash !== undefined && expectedParentHash !== block.parentHash) {
        this.handleReorg(block, provider);
      }

      // Track block hash for future continuity checks.
      this.blocks.set(block.number, block.hash);

      const [blockNumber, currentTime] = [parseInt(block.number.toString()), parseInt(block.timestamp.toString())];
      this.emit("block", blockNumber, currentTime);

      // Prune finalized blocks (well beyond any realistic re-org depth).
      const pruneThreshold = block.number - 128n;
      const staleBlocks = [...this.blocks.keys()].filter((num) => num < pruneThreshold);
      staleBlocks.forEach((num) => this.blocks.delete(num));
    };

    const blockError = (error: Error, provider: string) => {
      const message = `Caught ${chain} provider error.`;
      const { message: errorMessage, details, shortMessage, metaMessages } = error as BaseError;
      logger.warn({ at, message, errorMessage, shortMessage, provider, details, metaMessages });
    };

    this.on("block", handler);
    const [provider] = this.providers;
    provider.watchBlocks({
      emitOnBegin: true,
      onBlock: (block: Block) => newBlock(block, provider.name),
      onError: (error: Error) => blockError(error, provider.name),
    });
  }

  private handleReorg(block: Block, provider: string): void {
    const at = "EventListener::handleReorg";
    const { chain, eventMgr, logger } = this;

    // Find the fork point by locating the new block's parentHash in our stored chain.
    let forkedBlock: number | undefined;
    for (const [num, hash] of this.blocks) {
      if (hash === block.parentHash) {
        forkedBlock = Number(num);
        break;
      }
    }

    // If no fork point was found within our window, fall back to the highest observed block.
    forkedBlock ??= Math.max(...[...this.blocks.keys()].map(Number));
    logger.warn({
      at,
      message: `${chain} re-org detected at block ${block.number}; resuming from block ${forkedBlock}.`,
      provider,
    });

    // Eject orphaned events from EventManager.
    const removed = eventMgr.removeAbove(forkedBlock);
    for (const event of removed) {
      this.emit(event.event, { ...event, removed: true });
    }

    // Prune orphaned blocks from our chain tracker.
    const orphanedBlocks = [...this.blocks.keys()].filter((num) => Number(num) > forkedBlock);
    for (const num of orphanedBlocks) {
      this.blocks.delete(num);
    }
  }

  onEvent(address: string, event: string, handler: (log: Log) => void): void {
    this.onEvents(address, [event], handler);
  }

  onEvents(address: string, events: string[], handler: (log: Log) => void): void {
    const { eventMgr, providers } = this;
    events.forEach((eventDescriptor) => {
      // Viem is unhappy with "tuple" in the event descriptor; sub it out.
      // Viem also complains about the return type of parseAbiItem() (@todo: why), so coerce it.
      const event = parseAbiItem(eventDescriptor.replace("tuple", "")) as AbiEvent;
      this.on(event.name, handler);

      providers.forEach((provider) => {
        const onLogs = (logs: (viemLog & { args: unknown; eventName: string })[]) => {
          logs.forEach((log) => {
            const event = {
              ...log,
              args: log.args,
              blockNumber: Number(log.blockNumber),
              event: log.eventName,
              topics: Array<string>(), // Not supplied by viem, but not actually used by the relayer.
            };

            if (log.removed) {
              eventMgr.remove(event, provider.name);
              this.emit(event.event, event);
              return;
            }

            if (eventMgr.add(event, provider.name)) {
              this.emit(event.event, event);
            }
          });
        };

        const onError = (error: Error) => {
          const { message: errorMessage, details, shortMessage, metaMessages } = error as BaseError;
          this.logger.warn({
            at: "EventListener::onEvents",
            message: `Caught ${this.chain} ${event.name} provider error.`,
            errorMessage,
            shortMessage,
            provider: provider.name,
            details,
            metaMessages,
          });
        };

        provider.watchEvent({ address: address as `0x${string}`, event, onLogs, onError });
      });
    });
  }
}
