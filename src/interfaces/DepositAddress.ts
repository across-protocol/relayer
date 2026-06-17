export interface RouteParams {
  inputToken: string;
  outputToken: string;
  originChainId: string;
  destinationChainId: string;
  recipient: string;
  refundAddress: string;
}

export type DepositAddressTransferClassification = "correct_transfer" | "mis_route" | "intent_refund";

export interface Erc20Transfer {
  chainId: string;
  blockNumber: number;
  logIndex: number;
  from: string;
  to: string;
  amount: string;
  contractAddress: string;
  transactionHash: string;
  transferClassification: DepositAddressTransferClassification;
}

export interface CounterfactualLeaf {
  implementationAddress: string;
  encodedParams: string;
  leafHash: string;
  merkleProof: string[];
}

/**
 * Bridge leaf that carries the `executionFee` committed into the merkle root at deposit-address
 * creation time (decimal string, input-token base units; absent on pre-fee messages, "0" on
 * sponsored routes). The bot echoes this value back to the swap API verbatim so the rebuilt proof
 * verifies. Only `cctpLeaf`/`spokePoolLeaf` carry it; `withdrawLeaf` never does.
 */
export interface ExecutionFeeLeaf extends CounterfactualLeaf {
  params?: { executionFee: string };
}

export interface CounterfactualMaterials {
  withdrawLeaf: CounterfactualLeaf;
  cctpLeaf?: ExecutionFeeLeaf;
  spokePoolLeaf?: ExecutionFeeLeaf;
}

/**
 * Integrator attribution projected from the deposit address's CDA `integrator` jsonb. The indexer
 * surfaces this on every `/deposit-address-transfers` item (v1 and v3); `apiKeyHash` is
 * intentionally omitted (sensitive). `integratorId` is a 2-byte hex string (or null when the
 * deposit address has no integrator recorded).
 */
export interface DepositAddressIntegrator {
  name: string;
  integratorId: string | null;
}

export interface DepositAddressMessage {
  depositAddress: string;
  paramsHash: string;
  routeParams: RouteParams;
  erc20Transfer: Erc20Transfer;
  salt: string;
  counterfactualDepositContractAddress: string;
  counterfactualFactoryContractAddress: string;
  adminWithdrawManagerContractAddress: string;
  counterfactualMaterials: CounterfactualMaterials;
  shouldSponsorAccountCreation: boolean;
  /** Indexer message version. v1 (or absent = legacy v1) and v3 are processed; v2 is ignored. */
  version?: number;
  /** Optional during rollout: pre-integrator indexer messages omit it. */
  integrator?: DepositAddressIntegrator | null;
}

/**
 * Account in the Across namespace vocabulary (`evm`, `zksync`, `tron`, `solana`; kept open for
 * forward-compat). Deliberately not CAIP-2: `eip155` cannot distinguish zkSync-stack chains
 * (different CREATE2 derivation) from standard EVM, so `evm`/`zksync` are split by derivation
 * class, not VM family.
 */
export interface NamespacedAccount {
  namespace: string;
  address: string;
}

/**
 * v3 route leaf, relayed verbatim from the indexer. The bot never reads these for execution —
 * the quote-api re-derives the full merkle set server-side — they are carried for
 * forward-compat and diagnostics only.
 */
export interface CounterfactualMaterialV3 {
  kind: string;
  implementationAddress: string;
  encodedParams: string;
  leafHash: string;
  merkleProof: string[];
}

/** v3 route params. Funding context (origin chain, input token, amount) lives in `erc20Transfer`. */
export interface RouteParamsV3 {
  outputToken: string;
  destinationChainId: string;
  recipient: NamespacedAccount;
}

/**
 * v3 (upgradeable-counterfactual) `/deposit-address-transfers` item. Mirrors the indexer's
 * `DepositAddressTransferItemV3` projection: durable identity + relayed merkle materials, with
 * the shared `erc20Transfer` funding envelope. No `paramsHash` or
 * `counterfactualDepositContractAddress` — those are v1-only.
 */
export interface DepositAddressMessageV3 {
  depositAddress: string;
  version: 3;
  salt: string;
  initialRoot: string;
  counterfactualBeaconContractAddress: string;
  counterfactualFactoryContractAddress: string;
  adminWithdrawManagerContractAddress: string;
  shouldSponsorAccountCreation: boolean;
  counterfactualMaterials: CounterfactualMaterialV3[];
  routeParams: RouteParamsV3;
  refundAddress: NamespacedAccount;
  depositAddressNamespace: string;
  erc20Transfer: Erc20Transfer;
  /** Optional during rollout: pre-integrator indexer messages omit it. Relayed to the execute endpoint. */
  integrator?: DepositAddressIntegrator | null;
}

/** A `/deposit-address-transfers` item, discriminated on `version`. */
export type AnyDepositAddressMessage = DepositAddressMessage | DepositAddressMessageV3;

/** Type guard discriminating v3 items from v1/legacy. */
export function isDepositAddressMessageV3(message: AnyDepositAddressMessage): message is DepositAddressMessageV3 {
  return message.version === 3;
}

// TODO: Add schema for SwapAPI response.
export interface DepositSignApiResponse {
  signature: string;
}
