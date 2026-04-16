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
// emitted by `watchBlocks`. Each registered poller tracks its own previous block and fetches logs
// over (prev, current].

function resolveProviders(chainId: number, quorum = 1) {
  const protocol = process.env[`RPC_PROVIDERS_TRANSPORT_${chainId}`] ?? "wss";
  assert(protocol === "wss" || protocol === "https");

  const urls = Object.values(getNodeUrlList(chainId, quorum, protocol));
  const nProviders = urls.length;
  const chain = getNetworkName(chainId);
  assert(nProviders >= quorum, `Insufficient providers for ${chain} (minimum ${quorum} required by quorum)`);

  const viemChain = getViemChain(chainId);
  const pollingInterval =
    protocol === "https"
      ? (() => {
          const blockTime = viemChain.blockTime ?? (chainIsTvm(chainId) ? 3_000 : undefined);
          const pollUpdateRate = Number(process.env[`RPC_PROVIDERS_POLL_UPDATE_RATE_${chainId}`]) || 1;
          return blockTime !== undefined ? Math.ceil(blockTime * pollUpdateRate) : undefined;
        })()
      : undefined;

  const providers = Object.entries(urls).map(([provider, url]) => {
    const headers = getProviderHeaders(provider, chainId);
    const transport = protocol === "wss" ? webSocket(url) : http(url, { fetchOptions: { headers } });

    return createPublicClient({
      chain: viemChain,
      transport,
      name: getOriginFromURL(url),
      pollingInterval,
    });
  });

  return providers;
}

export class EventListener extends EventEmitter {
  public readonly chain: string;
  private readonly eventMgr: EventManager;
  private readonly providers: ReturnType<typeof resolveProviders>;
  // private readonly abortController: AbortController;
  private readonly tvmBlocks: { [provider: string]: { [event: string]: bigint } } = {};
  private watchBlocksStarted = false;

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
    this.on("block", handler);
    this.startWatchBlocks();
  }

  private startWatchBlocks(): void {
    if (this.watchBlocksStarted) {
      return;
    }
    this.watchBlocksStarted = true;

    const at = "EventListener::startWatchBlocks";
    const { chain, logger } = this;

    const newBlock = (block: Block, provider: string) => {
      // Transient error that sometimes occurs. Catch it here and try to flush out the provider.
      if (!block) {
        logger.debug({ at, message: `Received empty ${chain} block from ${provider}.` });
        return;
      }
      const [blockNumber, currentTime] = [parseInt(block.number.toString()), parseInt(block.timestamp.toString())];
      this.emit("block", blockNumber, currentTime);
    };

    const blockError = (error: Error, provider: string) => {
      const message = `Caught ${chain} provider error.`;
      const { message: errorMessage, details, shortMessage, metaMessages } = error as BaseError;
      logger.warn({ at, message, errorMessage, shortMessage, provider, details, metaMessages });
    };

    const [provider] = this.providers;
    provider.watchBlocks({
      emitOnBegin: true,
      onBlock: (block: Block) => newBlock(block, provider.name),
      onError: (error: Error) => blockError(error, provider.name),
    });
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

        if (tvm) {
          this.tvmBlocks[provider.name] ??= {};
          this.on("block", async (blockNumber: number) => {
            const toBlock = BigInt(blockNumber);
            const previousBlockNumber = (this.tvmBlocks[provider.name][eventDescriptor] ??= toBlock);
            if (previousBlockNumber >= toBlock) {
              return; // xxx consider re-orgs.
            }

            const fromBlock = previousBlockNumber + 1n;
            let logs: Parameters<typeof onLogs>[0] = [];
            try {
              logs = await provider.getLogs({ address: address as `0x${string}`, event, fromBlock, toBlock });
            } catch (err) {
              onError(err);
              return;
            }

            if ((this.tvmBlocks[provider.name][eventDescriptor] ?? 0n) < toBlock) {
              this.tvmBlocks[provider.name][eventDescriptor] = toBlock;
            }
            if (logs.length > 0) {
              onLogs(logs);
            }
          });
          return;
        }

        provider.watchEvent({ address: address as `0x${string}`, event, onLogs, onError });
      });
    });

    // Ensure watchBlocks is running so registered TVM pollers actually tick.
    if (tvm) {
      this.startWatchBlocks();
    }
  }
}
