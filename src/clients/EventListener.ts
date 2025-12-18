import assert from "assert";
import { EventEmitter } from "node:events";
import * as chains from "viem/chains";
import {
  AbiEvent,
  BaseError,
  Block,
  createPublicClient,
  http,
  Log as viemLog,
  parseAbiItem,
  WatchEventReturnType,
  webSocket,
} from "viem";
import { Log } from "../interfaces";
import { EventManager, getNetworkName, getNodeUrlList, getOriginFromURL, getProviderHeaders, winston } from "../utils";

// Teach BigInt how to be represented as JSON.
(BigInt.prototype as any).toJSON = function () {
  return this.toString();
};

function resolveProviders(chainId: number, quorum = 1) {
  const protocol = process.env[`RPC_PROVIDERS_TRANSPORT_${chainId}`] ?? "wss";
  assert(protocol === "wss" || protocol === "https");

  const urls = Object.values(getNodeUrlList(chainId, quorum, protocol));
  const nProviders = urls.length;
  const chain = getNetworkName(chainId);
  assert(nProviders >= quorum, `Insufficient providers for ${chain} (minimum ${quorum} required by quorum)`);

  const viemChain = Object.values(chains).find(({ id }) => id === chainId);
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
  private readonly eventMgr: EventManager;
  private readonly providers: ReturnType<typeof resolveProviders>;
  // private readonly abortController: AbortController;

  constructor(public readonly chainId: number, private readonly logger: winston.Logger, public readonly quorum = 1) {
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

    this.on("block", handler);
    const [provider] = this.providers;
    provider.watchBlocks({
      emitOnBegin: true,
      onBlock: (block: Block) => newBlock(block, provider.name),
      onError: (error: Error) => blockError(error, provider.name),
    });
  }

  stop(event: string): void {
    this.removeAllListeners(event);
    const watchers = this.watchers[event] ?? [];
    watchers.forEach((unwatch) => {
      unwatch();
    });
  }

  onEvent(address: string, event: string, handler: (log: Log) => void): void {
    this.onEvents(address, [event], handler);
  }

  private watchers: { [event: string]: WatchEventReturnType[] } = {};

  onEvents(address: string, events: string[], handler: (log: Log) => void): void {
    const { eventMgr, providers, watchers } = this;
    events.forEach((eventDescriptor) => {
      // Viem is unhappy with "tuple" in the event descriptor; sub it out.
      // Viem also complains about the return type of parseAbiItem() (@todo: why), so coerce it.
      const event = parseAbiItem(eventDescriptor.replace("tuple", "")) as AbiEvent;
      watchers[event.name] ??= [];
      this.on(event.name, handler);

      providers.forEach((provider) => {
        const onLogs = (logs: viemLog[]) => {
          logs.forEach((log) => {
            const event = {
              ...log,
              args: log["args"],
              blockNumber: Number(log.blockNumber),
              event: log["eventName"],
              topics: [], // Not supplied by viem, but not actually used by the relayer.
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

        const unwatch = provider.watchEvent({
          address: address as `0x${string}`,
          event,
          onLogs,
        });
        watchers[event.name].push(unwatch);
      });
    });
  }
}
