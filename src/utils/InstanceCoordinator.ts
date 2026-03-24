import { RedisCacheInterface } from "../caching/RedisCache";
import { delay, winston } from "./";

export class InstanceCoordinator {
  constructor(
    private readonly logger: winston.Logger,
    private readonly redis: RedisCacheInterface,
    public readonly identifier: string,
    public readonly instance: string,
    private readonly abortController: AbortController,
    public readonly instanceExpiry = 900
  ) {}

  async getActiveInstance(): Promise<string | undefined> {
    return (await this.redis.get(this.identifier)) ?? Promise.resolve(undefined);
  }

  setActiveInstance(): Promise<string> {
    return this.redis.set(this.identifier, this.instance, this.instanceExpiry);
  }

  async isActiveInstance(): Promise<boolean> {
    return (await this.getActiveInstance()) === this.instance;
  }

  async initiateHandover(): Promise<void> {
    const activeInstance = await this.getActiveInstance();
    this.logger.debug({
      at: "Coordinator::initiateHandover",
      message: `Taking over from ${this.identifier} instance ${activeInstance}.`,
    });

    await this.setActiveInstance();
  }

  // Poor-man's subscription - just poll on a 1s interval.
  async subscribe(): Promise<string | undefined> {
    let activeInstance: string | undefined;
    do {
      await delay(1);
      if (this.abortController.signal.aborted) {
        activeInstance = undefined;
        break;
      }

      activeInstance = await this.redis.get<string>(this.identifier);
    } while (activeInstance === this.instance);

    if (activeInstance !== this.instance) {
      this.logger.debug({
        at: "Coordinator::monitorInstance",
        message: `Handover requested by ${this.identifier} instance ${activeInstance}.`,
      });
    }

    return activeInstance ?? undefined;
  }
}
