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

  async initiateHandover(onHandover: (newInstance: string) => void): Promise<void> {
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
        console.log(`xxx got active instance ${activeInstance}`);
      } while (activeInstance === this.instance);

      this.logger.debug({
        at: "Coordinator::monitorInstance",
        message: `Handover requested by ${this.identifier} instance ${activeInstance}.`,
      });
      onHandover(activeInstance);
    };

    // this.subInterface.sub(this.identifier, (message: string, channel: string) => console.log(`xxx handover on ${channel} from ${message}`));

    await this.redis.set(this.identifier, this.instance, this.instanceExpiry);
    return monitorInstance();
  }
}
