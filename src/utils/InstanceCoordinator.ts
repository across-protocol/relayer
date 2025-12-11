import { EventEmitter } from "node:events";
import { RedisCacheInterface } from "../caching/RedisCache";
import { delay, winston } from "./";

export class InstanceCoordinator extends EventEmitter {
  constructor(
    private readonly logger: winston.Logger,
    private readonly redis: RedisCacheInterface,
    public readonly identifier: string,
    public readonly instance: string,
    public readonly instanceExpiry = 900
  ) {
    super();
  }

  async getActiveInstance(): Promise<string | undefined> {
    return (await this.redis.get(this.identifier)) ?? Promise.resolve(undefined);
  }

  async initiateHandover(): Promise<void> {
    const activeInstance = await this.getActiveInstance();
    this.logger.debug({
      at: "Coordinator::initiateHandover",
      message: `Taking over from ${this.identifier} instance ${activeInstance}.`,
    });

    const monitorInstance = async () => {
      let activeInstance: string;
      do {
        await delay(1);
        activeInstance = await this.redis.get<string>(this.identifier);
      } while (activeInstance === this.instance);

      this.logger.debug({
        at: "Coordinator::monitorInstance",
        message: `Handover requested by ${this.identifier} instance ${activeInstance}.`,
      });
      this.emit("handover", activeInstance);
    };

    await this.redis.set(this.identifier, this.instance, this.instanceExpiry);
    monitorInstance();
  }
}
