import assert from "assert";
import { assert as ssAssert, enums } from "superstruct";
import { CommonConfig, FINALIZER_TOKENBRIDGE_LOOKBACK, ProcessEnv } from "../common";
import { Address, EvmAddress } from "../utils";

/**
 * The finalization type is used to determine the direction of the finalization.
 */
type FinalizationType = "l1->l2" | "l2->l1" | "l1<->l2" | "any<->any";

export class FinalizerConfig extends CommonConfig {
  public readonly finalizationStrategy: FinalizationType;
  public readonly maxFinalizerLookback: number;
  public readonly userAddresses: Map<Address, string[]>;
  public chainsToFinalize: number[];

  constructor(env: ProcessEnv) {
    const {
      FINALIZER_MAX_TOKENBRIDGE_LOOKBACK,
      FINALIZER_CHAINS = "[]",
      FINALIZER_WITHDRAWAL_TO_ADDRESSES = "[]",
      FINALIZATION_STRATEGY = "l1<->l2",
    } = env;
    super(env);

    const userAddresses: { [address: string]: string[] } = JSON.parse(FINALIZER_WITHDRAWAL_TO_ADDRESSES);
    this.userAddresses = new Map();
    Object.entries(userAddresses).forEach(([address, tokensToFinalize]) => {
      this.userAddresses.set(EvmAddress.from(address), tokensToFinalize);
    });

    this.chainsToFinalize = JSON.parse(FINALIZER_CHAINS);

    // `maxFinalizerLookback` is how far we fetch events from, modifying the search config's 'fromBlock'
    this.maxFinalizerLookback = Number(FINALIZER_MAX_TOKENBRIDGE_LOOKBACK ?? FINALIZER_TOKENBRIDGE_LOOKBACK);
    assert(
      Number.isInteger(this.maxFinalizerLookback),
      `Invalid FINALIZER_MAX_TOKENBRIDGE_LOOKBACK: ${FINALIZER_MAX_TOKENBRIDGE_LOOKBACK}`
    );

    const _finalizationStrategy = FINALIZATION_STRATEGY.toLowerCase();
    ssAssert(_finalizationStrategy, enums(["l1->l2", "l2->l1", "l1<->l2", "any<->any"]));
    this.finalizationStrategy = _finalizationStrategy;
  }
}
