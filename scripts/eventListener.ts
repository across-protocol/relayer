// import { Block } from "viem";
import { utils as ethersUtils } from "ethers";
import { Log } from "../src/interfaces";
import { EventListener } from "../src/clients";
import { getDeployedContract, Logger as logger } from "../src/utils";

// Teach BigInt how to be represented as JSON.
(BigInt.prototype as any).toJSON = function () {
  return this.toString();
};

async function run() {
  const chainId = 8453;
  const spokePool = getDeployedContract("SpokePool", chainId);
  const listener = new EventListener(chainId, logger, 1);
  const newBlock = (blockNumber: number, timestamp: number) => {
    console.log(`xxx got block ${blockNumber} @ ${timestamp}`);
  };
  const newFill = (event: Log) => {
    console.log(`xxx got event ${event.event}`);
  };

  const eventDescriptor = spokePool.interface.getEvent("FilledRelay");
  const eventFormatted = eventDescriptor.format(ethersUtils.FormatTypes.full);

  listener.onBlock(newBlock);
  listener.onEvent(spokePool.address, eventFormatted, newFill);
}

if (require.main === module) {
  run()
    .then(async () => {
      process.exitCode = 0;
    })
    .catch(async (error) => {
      console.error("Process exited with", error);
      process.exitCode = 128;
    });
}
