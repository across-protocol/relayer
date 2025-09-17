import { BalanceAllocator, ConfigStoreClient, HubPoolClient } from "../src/clients";
import { Refiller } from "../src/refiller/Refiller";
import { RefillerConfig } from "../src/refiller/RefillerConfig";
import { originChainId } from "./constants";
import { MockedMultiCallerClient, MockHubPoolClient } from "./mocks";
import { createSpyLogger, deployConfigStore, ethers, expect, hubPoolFixture } from "./utils";

describe("Refiller", function () {
  it("should refill native token balances", async function () {
    const { spyLogger } = createSpyLogger();
    const { hubPool } = await hubPoolFixture();
    const [owner, otherGuy] = await ethers.getSigners();
    const { configStore } = await deployConfigStore(owner, []);
    const configStoreClient = new ConfigStoreClient(spyLogger, configStore);
    await configStoreClient.update();

    const hubPoolClient = new MockHubPoolClient(spyLogger, hubPool, configStoreClient) as unknown as HubPoolClient;
    const refillConfig = [
      {
        account: hubPool.address,
        isHubPool: true,
        chainId: hubPoolClient.chainId,
        trigger: 1,
        target: 2,
      },
      {
        account: otherGuy.address,
        isHubPool: false,
        chainId: originChainId,
        trigger: 1,
        target: 2,
      },
    ];
    const monitorEnvs = {
      REFILL_BALANCES: JSON.stringify(refillConfig),
    };
    const config = new RefillerConfig(monitorEnvs);
    const balanceAllocator = new BalanceAllocator({
      [hubPoolClient.chainId]: hubPool.provider,
      [originChainId]: hubPool.provider,
    });
    const multiCallerClient = new MockedMultiCallerClient(spyLogger);
    const clients = {
      balanceAllocator,
      hubPoolClient,
      multiCallerClient,
    };
    const refiller = new Refiller(spyLogger, config, clients);
    await refiller.initialize();
    await refiller.refillNativeTokenBalances();

    expect(multiCallerClient.transactionCount()).to.equal(1);
    await multiCallerClient.executeTxnQueues();
  });
});
