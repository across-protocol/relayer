import { BaseChainAdapter } from "../../src/adapter";
import { EventSearchConfig, MakeOptional, winston } from "../../src/utils";

export class MockBaseChainAdapter extends BaseChainAdapter {
  constructor() {
    super(
      {},
      0,
      0,
      [],
      winston.createLogger({
        level: "debug",
        transports: [new winston.transports.Console()],
      }),
      [],
      {},
      {},
      0
    );
  }
  getSearchConfig(): MakeOptional<EventSearchConfig, "toBlock"> {
    return { fromBlock: 0 };
  }
  isSupportedL2Bridge(): boolean {
    return true;
  }
}
