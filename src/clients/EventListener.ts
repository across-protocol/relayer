import assert from "assert";
import { EventEmitter } from "node:events";
import { AbiEvent, BaseError, Block, createPublicClient, http, Log as viemLog, parseAbiItem, webSocket } from "viem";
import { Log } from "../interfaces";
import {
  chainIsTvm,
  EventManager,
  getNetworkName,
  getNodeUrlList,
  getOriginFromURL,
  getProviderHeaders,
  getViemChain,
  winston,
} from "../utils";

// Tron's JSON-RPC compat layer exposes eth_newFilter / eth_getFilterChanges, but filter state is
// only retained on the backend node that handled eth_newFilter. Subsequent polls load-balance to
// other nodes that have no record of the filter, silently returning empty arrays — so viem's
// `watchEvent` never surfaces logs. On TVM chains we instead drive getLogs off each new block
// emitted by `watchBlocks`, fetching all registered events in one batched call per provider.

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

// Per-provider TVM state: addresses/events to include in getLogs calls.
interface TvmRegistryEntry {
  addresses: Set<`0x${string}`>;
  events: Map<string, AbiEvent>;
}

export class EventListener extends EventEmitter {
  public readonly chain: string;
  protected readonly eventMgr: EventManager;
  private readonly providers: ReturnType<typeof resolveProviders>;
  protected readonly blocks: Map<bigint, string> = new Map();

  // Per-provider high-water mark for the TVM getLogs poller.
  protected readonly tvmBlocks: { [provider: string]: bigint } = {};
  // Per-provider registry of (addresses, events) that each TVM poll should fetch.
  private readonly tvmRegistry: { [provider: string]: TvmRegistryEntry } = {};

  constructor(
    public readonly chainId: number,
    private readonly logger: winston.Logger,
    public readonly quorum = 1
  ) {
    super();
    this.chain = getNetworkName(chainId);
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

    // On TVM chains, register one block-driven poller per provider. Each poller batch-fetches all
    // registered events via getLogs. onEvents() populates the per-provider registry.
    if (chainIsTvm(this.chainId)) {
      this.providers.forEach((p) => {
        this.on("block", (blockNumber: number) => {
          void this.tvmPoll(p, blockNumber);
        });
      });
    }
  }

  private async tvmPoll(provider: ReturnType<typeof resolveProviders>[number], blockNumber: number): Promise<void> {
    const { chain, eventMgr, logger } = this;
    const registry = this.tvmRegistry[provider.name];
    if (!registry || registry.events.size === 0) {
      return;
    }

    const toBlock = BigInt(blockNumber);
    const previousBlockNumber = (this.tvmBlocks[provider.name] ??= toBlock);
    if (previousBlockNumber >= toBlock) {
      return;
    }

    const fromBlock = previousBlockNumber + 1n;
    let logs: (viemLog & { args: unknown; eventName: string })[] = [];
    try {
      logs = await provider.getLogs({
        address: [...registry.addresses],
        events: [...registry.events.values()],
        fromBlock,
        toBlock,
      });
    } catch (err) {
      const { message: errorMessage, details, shortMessage, metaMessages } = err as BaseError;
      logger.warn({
        at: "EventListener::tvmPoll",
        message: `Caught ${chain} TVM getLogs error.`,
        errorMessage,
        shortMessage,
        provider: provider.name,
        details,
        metaMessages,
      });
      return;
    }

    if ((this.tvmBlocks[provider.name] ?? 0n) < toBlock) {
      this.tvmBlocks[provider.name] = toBlock;
    }

    logs.forEach((log) => {
      const ev = {
        ...log,
        args: log.args,
        blockNumber: Number(log.blockNumber),
        event: log.eventName,
        topics: Array<string>(),
      };
      if (log.removed) {
        eventMgr.remove(ev, provider.name);
        this.emit(ev.event, ev);
        return;
      }
      if (eventMgr.add(ev, provider.name)) {
        this.emit(ev.event, ev);
      }
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

    // If no fork point was found within our window, the reorg is deeper than we can see. Eject
    // everything tracked by setting the fork below our oldest block.
    forkedBlock ??= Math.min(...[...this.blocks.keys()].map(Number)) - 1;
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

    // Reset TVM poller high-water marks above the fork so they re-scan the affected range.
    const bigFork = BigInt(forkedBlock);
    for (const providerName of Object.keys(this.tvmBlocks)) {
      if (this.tvmBlocks[providerName] > bigFork) {
        this.tvmBlocks[providerName] = bigFork;
      }
    }
  }

  onEvent(address: string, event: string, handler: (log: Log) => void): void {
    this.onEvents(address, [event], handler);
  }

  onEvents(address: string, events: string[], handler: (log: Log) => void): void {
    const { chainId, eventMgr, logger, providers } = this;
    const at = "EventListener::onEvents";
    const tvm = chainIsTvm(chainId);

    events.forEach((eventDescriptor) => {
      // Viem is unhappy with "tuple" in the event descriptor; sub it out.
      // Viem also complains about the return type of parseAbiItem() (@todo: why), so coerce it.
      const event = parseAbiItem(eventDescriptor.replace("tuple", "")) as AbiEvent;
      this.on(event.name, handler);

      providers.forEach((provider) => {
        if (tvm) {
          // Accumulate into this provider's registry; the block-driven poller (set up in onBlock)
          // fetches all registered events in one batched getLogs call per block.
          const registry = (this.tvmRegistry[provider.name] ??= {
            addresses: new Set<`0x${string}`>(),
            events: new Map<string, AbiEvent>(),
          });
          registry.addresses.add(address as `0x${string}`);
          registry.events.set(eventDescriptor, event);
          return;
        }

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

        const onError = (error: unknown) => {
          const { message: errorMessage, details, shortMessage, metaMessages } = error as BaseError;
          logger.warn({
            at,
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
