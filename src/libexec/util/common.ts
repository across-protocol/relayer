import assert from "assert";
import minimist from "minimist";
import { getChainQuorum } from "../../utils";

type ListenerArgs = {
  lookback: string;
  maxBlockRange: number;
  relayer?: string;
  spokePoolAddr?: string;
};

const DEFAULT_GETLOGS_BLOCK_RANGE = 10_000;

export function parseArgs(argv: string[]): ListenerArgs {
  const minimistOpts = {
    string: ["lookback", "relayer", "spokepool"],
  };
  const args = minimist(argv, minimistOpts);

  const {
    chainid: chainId,
    lookback,
    relayer = null,
    blockrange: maxBlockRange = DEFAULT_GETLOGS_BLOCK_RANGE,
    spokepool: spokePoolAddr,
  } = args;

  assert(Number.isInteger(chainId), "chainId must be numeric ");
  assert(Number.isInteger(maxBlockRange), "maxBlockRange must be numeric");

  const { quorum = getChainQuorum(chainId) } = args;
  assert(Number.isInteger(quorum), "quorum must be numeric ");

  return { lookback, relayer, maxBlockRange, spokePoolAddr };
}
