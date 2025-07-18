import { delay, winston, getProvider, getDeployedContract, isDefined } from "./";
import { HubPoolClient } from "../clients";

export function exit(code: number): void {
  // eslint-disable-next-line no-process-exit
  process.exit(code);
}

export async function processEndPollingLoop(
  logger: winston.Logger,
  fileName: string,
  pollingDelay: number
): Promise<boolean> {
  if (pollingDelay === 0) {
    logger.debug({ at: `${fileName}#index`, message: "End of serverless execution loop - terminating process" });
    return true;
  }

  logger.debug({ at: `${fileName}#index`, message: `End of execution loop - waiting polling delay ${pollingDelay}s` });
  await delay(pollingDelay);
  return false;
}

export function startupLogLevel(config: { pollingDelay: number }): string {
  return config.pollingDelay > 0 ? "info" : "debug";
}

export function rejectAfterDelay(seconds: number, message = ""): Promise<never> {
  return new Promise<never>((_, reject) => {
    setTimeout(reject, seconds * 1000, {
      status: "timeout",
      message: `Execution took longer than ${seconds}s. ${message}`,
    });
  });
}

export async function getChallengeRemaining(chainId: number, hubPoolClient?: HubPoolClient): Promise<number> {
  const getHubPool = async () => {
    if (isDefined(hubPoolClient)) {
      return hubPoolClient.hubPool;
    }
    const provider = await getProvider(chainId);
    return getDeployedContract("HubPool", chainId).connect(provider);
  };
  const hubPool = await getHubPool();

  const [proposal, currentTime] = await Promise.all([hubPool.rootBundleProposal(), hubPool.getCurrentTime()]);
  const { challengePeriodEndTimestamp } = proposal;

  return Math.max(challengePeriodEndTimestamp - currentTime, 0);
}
