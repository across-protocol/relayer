/* eslint-disable @typescript-eslint/no-explicit-any */
import { utils as sdkUtils, typeguards, providers as sdkProviders } from "@across-protocol/sdk";
import {
  winston,
  getNetworkName,
  Contract,
  BigNumber,
  blockExplorerLink,
  toBNWei,
  TransactionReceipt,
  TransactionResponse,
  TransactionSimulationResult,
  willSucceed,
  stringifyThrownValue,
  delay,
  ethers,
  bnZero,
  getGasPrice,
  fixedPointAdjustment,
  parseUnits,
  CHAIN_IDs,
  assert,
  Provider,
  Signer,
  isDefined,
} from "../utils";
import { DEFAULT_GAS_FEE_SCALERS } from "../common";
import { FeeData } from "@ethersproject/abstract-provider";

// Empirically, a max fee scaler of ~5% can result in successful transaction replacement.
// Stuck transactions are very disruptive, so go for 10% to avoid the hassle.
const MIN_GAS_RETRY_SCALER_DEFAULT = 1.1;
const MAX_GAS_RETRY_SCALER_DEFAULT = 3;
const TRANSACTION_SUBMISSION_RETRIES_DEFAULT = 3;

// Define chains that require legacy (type 0) transactions
export const LEGACY_TRANSACTION_CHAINS = [CHAIN_IDs.BSC];

export interface AugmentedTransaction {
  contract: Contract;
  chainId: number;
  method: string;
  args: any[];
  gasLimit?: BigNumber;
  gasLimitMultiplier?: number;
  message?: string;
  mrkdwn?: string;
  value?: BigNumber;
  unpermissioned?: boolean; // If false, the transaction must be sent from the enqueuer of the method.
  // If true, then can be sent from the MakerDAO multisender contract.
  canFailInSimulation?: boolean;
  // Optional batch ID to use to group transactions
  groupId?: string;
  // If true, the transaction is being sent to a non Multicall contract so we can't batch it together
  // with other transactions.
  nonMulticall?: boolean;
  // Flag indicating whether the client should await the transaction response for onchain confirmation.
  ensureConfirmation?: boolean;
}

const { fixedPointAdjustment: fixedPoint } = sdkUtils;
const { isError } = typeguards;

export class TransactionClient {
  readonly noncesBySigner: { [chainId: number]: { [signerAddress: string]: number } } = {};
  private activeSignerIndex = 0;

  protected readonly DEFAULT_GAS_LIMIT_MULTIPLIER = 1.0;

  // eslint-disable-next-line no-useless-constructor
  constructor(readonly logger: winston.Logger, readonly signers: Signer[] = []) {}

  protected _simulate(txn: AugmentedTransaction): Promise<TransactionSimulationResult> {
    return willSucceed(txn);
  }

  // Each transaction is simulated in isolation; but on-chain execution may produce different
  // results due to execution sequence or intermediate changes in on-chain state.
  simulate(txns: AugmentedTransaction[]): Promise<TransactionSimulationResult[]> {
    return Promise.all(txns.map((txn: AugmentedTransaction) => this._simulate(txn)));
  }

  async dispatch(
    txn: Omit<AugmentedTransaction, "contract">,
    target: Contract,
    provider: Provider
  ): Promise<TransactionResponse> {
    assert(this.signers.length > 0, "Cannot dispatch transaction without any signers defined.");
    // Overwrite the signer on the augmented transaction.
    const signer = this.rotateSigners();
    const contract = target.connect(signer.connect(provider));
    const dispatchTxn = {
      ...txn,
      contract,
    };
    return (await this.submit(txn.chainId, [dispatchTxn]))[0];
  }

  protected _getTransactionPromise(txn: AugmentedTransaction, nonce: number | null): Promise<TransactionResponse> {
    const { contract, method, args, value, gasLimit } = txn;
    return _runTransaction(this.logger, contract, method, args, value, gasLimit, nonce);
  }

  protected async _submit(
    txn: AugmentedTransaction,
    opts: { nonce: number | null; maxTries?: number }
  ): Promise<TransactionResponse> {
    const { chainId } = txn;
    const { nonce = null, maxTries = 10 } = opts;
    const txnPromise = this._getTransactionPromise(txn, nonce);

    if (txn.ensureConfirmation) {
      const at = "TransactionClient#_submit";
      const chain = getNetworkName(txn.chainId);
      const txnResponse = await txnPromise;
      const txnArgs = { chainId, contract: txn.contract.address, method: txn.method };
      const txnRef = blockExplorerLink(txnResponse.hash, chainId);

      let txnReceipt: TransactionReceipt;
      let nTries = 0;
      do {
        try {
          // Must return a TransactionResponse, so await on the receipt, but discard it.
          txnReceipt = await txnResponse.wait();
        } catch (error) {
          if (!typeguards.isEthersError(error)) {
            throw error;
          }

          const { code } = error;
          const common = { at, code, txn: txnArgs, txnRef };
          switch (code) {
            case ethers.errors.CALL_EXCEPTION:
              // Call failed
              this.logger.warn({ ...common, message: `Transaction on ${chain} failed during execution...` });
              throw error;
            case ethers.errors.TRANSACTION_REPLACED:
              this.logger.warn({
                ...common,
                message: `Transaction submission on ${chain} replaced at nonce ${nonce}, resubmitting...`,
              });
              return this._submit(txn, { nonce: null, maxTries: maxTries - 1 });
            default:
              this.logger.warn({
                ...common,
                message: "Unhandled error while waiting for confirmation on transaction.",
              });
              await delay(0.25);
          }
        }
      } while (!txnReceipt && ++nTries < maxTries);

      if (!txnReceipt) {
        this.logger.warn({ at, message: `Unable to confirm ${chain} transaction.`, txnRef });
      }
    }

    return txnPromise;
  }

  async submit(chainId: number, txns: AugmentedTransaction[]): Promise<TransactionResponse[]> {
    const networkName = getNetworkName(chainId);
    const txnResponses: TransactionResponse[] = [];

    this.logger.debug({
      at: "TransactionClient#submit",
      message: `Processing ${txns.length} transactions.`,
    });

    // Transactions are submitted sequentially to avoid nonce collisions. More
    // advanced nonce management may permit them to be submitted in parallel.
    let mrkdwn = "";
    for (let idx = 0; idx < txns.length; ++idx) {
      const txn = txns[idx];

      if (txn.chainId !== chainId) {
        throw new Error(`chainId mismatch for method ${txn.method} (${txn.chainId} !== ${chainId})`);
      }

      const signerAddr = await txn.contract.signer.getAddress();
      const chainNonceMap = (this.noncesBySigner[chainId] ??= {});
      const nonce = isDefined(chainNonceMap[signerAddr]) ? chainNonceMap[signerAddr] + 1 : undefined;

      // @dev It's assumed that nobody ever wants to discount the gasLimit.
      const gasLimitMultiplier = txn.gasLimitMultiplier ?? this.DEFAULT_GAS_LIMIT_MULTIPLIER;
      if (gasLimitMultiplier > this.DEFAULT_GAS_LIMIT_MULTIPLIER) {
        this.logger.debug({
          at: "TransactionClient#_submit",
          message: `Padding gasLimit estimate on ${txn.method} transaction.`,
          estimate: txn.gasLimit,
          gasLimitMultiplier,
        });
        txn.gasLimit = txn.gasLimit?.mul(toBNWei(gasLimitMultiplier)).div(fixedPoint);
      }

      let response: TransactionResponse;
      try {
        response = await this._submit(txn, { nonce });
      } catch (error) {
        delete chainNonceMap[signerAddr];
        this.logger.info({
          at: "TransactionClient#submit",
          message: `Transaction ${idx + 1} submission on ${networkName} failed or timed out.`,
          mrkdwn,
          // @dev `error` _sometimes_ doesn't decode correctly (especially on Polygon), so fish for the reason.
          errorMessage: isError(error) ? (error as Error).message : undefined,
          error: stringifyThrownValue(error),
          notificationPath: "across-error",
        });
        return txnResponses;
      }

      chainNonceMap[signerAddr] = response.nonce;
      const blockExplorer = blockExplorerLink(response.hash, txn.chainId);
      mrkdwn += `  ${idx + 1}. ${txn.message || "No message"} (${blockExplorer}): ${txn.mrkdwn || "No markdown"}\n`;
      txnResponses.push(response);
    }

    this.logger.info({
      at: "TransactionClient#submit",
      message: `Completed ${networkName} transaction submission! 🧙`,
      mrkdwn,
    });

    return txnResponses;
  }

  private rotateSigners(): Signer {
    const activeSigner = this.signers[this.activeSignerIndex];
    this.activeSignerIndex = (this.activeSignerIndex + 1) % this.signers.length;
    return activeSigner;
  }
}

// @dev: If the method value is an empty string (i.e. ""), then this function will submit a raw transaction.
async function _runTransaction(
  logger: winston.Logger,
  contract: Contract,
  method: string,
  args: unknown,
  value = bnZero,
  gasLimit: BigNumber | null = null,
  nonce: number | null = null,
  retries?: number,
  retryScaler = 1.0
): Promise<TransactionResponse> {
  const at = "TxUtil#_runTransaction";
  const { provider, signer } = contract;
  const { chainId } = await provider.getNetwork();
  const chain = getNetworkName(chainId);
  const sendRawTxn = method === "";

  retries ??= Number(
    process.env[`TRANSACTION_SUBMISSION_RETRIES_${chainId}`] ??
      process.env.TRANSACTION_SUBMISSION_RETRIES ??
      TRANSACTION_SUBMISSION_RETRIES_DEFAULT
  );

  const priorityFeeScaler =
    Number(process.env[`PRIORITY_FEE_SCALER_${chainId}`] || process.env.PRIORITY_FEE_SCALER) ||
    DEFAULT_GAS_FEE_SCALERS[chainId]?.maxPriorityFeePerGasScaler;
  const maxFeePerGasScaler =
    Number(process.env[`MAX_FEE_PER_GAS_SCALER_${chainId}`] || process.env.MAX_FEE_PER_GAS_SCALER) ||
    DEFAULT_GAS_FEE_SCALERS[chainId]?.maxFeePerGasScaler;

  let gas: Partial<FeeData>;
  try {
    nonce ??= await provider.getTransactionCount(await signer.getAddress());
    const preGas = await getGasPrice(
      provider,
      priorityFeeScaler,
      maxFeePerGasScaler,
      sendRawTxn ? undefined : await contract.populateTransaction[method](...(args as Array<unknown>), { value })
    );
    gas = _scaleGasPrice(chainId, preGas, retryScaler);
  } catch (error) {
    // Linea uses linea_estimateGas and will throw on FilledRelay() reverts; skip retries.
    // nb. Requiring low-level chain & method inspection is a wart on the implementation. @todo: refactor it away.
    if ((chainId === CHAIN_IDs.LINEA && method === "fillRelay") || --retries < 0) {
      throw error;
    }
    return await _runTransaction(logger, contract, method, args, value, gasLimit, nonce, retries);
  }

  const to = contract.address;
  const commonFields = { chainId, to, method, args, value, nonce, gas, gasLimit, sendRawTxn };
  logger.debug({ at, message: "Submitting transaction.", ...commonFields });

  // TX config has gas (from gasPrice function), value (how much eth to send) and an optional gasLimit. The reduce
  // operation below deletes any null/undefined elements from this object. If gasLimit or nonce are not specified,
  // ethers will determine the correct values to use.
  const txConfig = Object.entries({ ...gas, value, nonce, gasLimit }).reduce(
    (a, [k, v]) => (v ? ((a[k] = v), a) : a),
    {}
  );

  try {
    return sendRawTxn
      ? await signer.sendTransaction({ to, value, data: (args as ethers.utils.BytesLike[])[0], gasLimit, ...gas })
      : await contract[method](...(args as Array<unknown>), txConfig);
  } catch (error) {
    // Narrow type. All errors caught here should be Ethers errors.
    if (!typeguards.isEthersError(error)) {
      throw error;
    }

    const getCause = (error: unknown): string => {
      const rpcError = sdkProviders.parseJsonRpcError(error);
      return rpcError?.message.toLowerCase() ?? "unknown error";
    };

    const { errors } = ethers;
    const { code, reason, error: rawError } = error;
    const cause = getCause(rawError);
    let scaleGas = false;
    let message = `Unhandled ${chain} transaction error (${cause})`;
    switch (code) {
      // Transaction fails on simulation. May be due to an actual revert, or due to a gas pricing issue.
      case errors.UNPREDICTABLE_GAS_LIMIT:
        message = `Unable to simulate transaction (${cause}).`;
        if ([cause, reason].some((err) => err.includes("revert"))) {
          logger.warn({ at, message, retries, reason, ...commonFields });
          throw error;
        }
        scaleGas = ["gas", "fee"].some((cause) => cause.includes(reason));
        break;

      case errors.REPLACEMENT_UNDERPRICED:
        message = `Transaction replacement on ${chain} failed at nonce ${nonce} (${cause}).`;
        scaleGas = true;
        break;

      // Undiagnosed issue. Can be a nonce issue, so try to re-sync, and otherwise
      // pull out the underlying error to support manual diagnosis if necessary.
      case errors.SERVER_ERROR:
        message = `Encountered error on ${chain} (${cause}).`;
        nonce = null;
        break;

      // Nonce collisions, likely due to concurrent bot instances running. Re-sync nonce and retry.
      case errors.NONCE_EXPIRED:
        nonce = null;
        message = `Nonce collision detected on ${chain}.`;
        break;

      case errors.TIMEOUT:
        message = `Timed out error on ${chain}.`;
        await delay(0.5); // Unclear whether we'll ever hit this in practice.
        break;

      // Likely irrecoverable error due to native token wrap/unwrap collision.
      case errors.INSUFFICIENT_FUNDS: {
        message = "Cannot execute transaction due to insufficent native token balance.";
        logger.warn({ at, message, code, reason, ...commonFields });
        throw error;
      }

      // Bad errors - likely something wrong in the codebase.
      case errors.INVALID_ARGUMENT: // fallthrough
      case errors.MISSING_ARGUMENT: // fallthrough
      case errors.UNEXPECTED_ARGUMENT: {
        message = `Attempted invalid ${chain} transaction (${cause}).`;
        logger.warn({ at, message, code, reason, ...commonFields });
        throw error;
      }

      default:
        logger.warn({ at, message, code, retries, ...commonFields });
    }

    logger.debug({ at, message, code, reason, ...commonFields });
    if (--retries < 0) {
      throw error;
    }

    if (scaleGas) {
      const maxGasScaler = Number(
        process.env[`MAX_GAS_RETRY_SCALER_DEFAULT_${chainId}`] ??
          process.env.MAX_GAS_RETRY_SCALER_DEFAULT ??
          MAX_GAS_RETRY_SCALER_DEFAULT
      );
      retryScaler *= Math.max(priorityFeeScaler, MIN_GAS_RETRY_SCALER_DEFAULT);
      retryScaler = Math.min(retryScaler, maxGasScaler);
    }

    return await _runTransaction(logger, contract, method, args, value, gasLimit, nonce, retries, retryScaler);
  }
}

/**
 * Apply local scaling to a gas price. The gas price can be scaled up in case it falls beneath an env-defined
 * price floor, or in case of a retry (i.e. due to replacement underpriced RPC rejection).
 * @param chainId Chain ID for transaction submission.
 * @param gas Input gas price (Legacy/type 0 or eip1559/type 2).
 * @param scaler Multiplier to apply to the gas price.
 * @returns A scaled type 0 or type 2 gas price, dependent on chainId.
 */
function _scaleGasPrice(
  chainId: number,
  gas: Pick<FeeData, "maxFeePerGas" | "maxPriorityFeePerGas">,
  retryScaler = 1.0
): Pick<FeeData, "maxFeePerGas" | "maxPriorityFeePerGas"> | Pick<FeeData, "gasPrice"> {
  let { maxFeePerGas, maxPriorityFeePerGas } = gas;

  const feeDeltaPct = toBNWei(Math.max(retryScaler - 1.0, 0));
  const computeFeeDelta = (maxFeePerGas: BigNumber): BigNumber =>
    maxFeePerGas.mul(feeDeltaPct).div(fixedPointAdjustment);

  // Legacy/type0 transactions.
  if (LEGACY_TRANSACTION_CHAINS.includes(chainId)) {
    const gasPrice = maxFeePerGas.add(computeFeeDelta(maxFeePerGas));
    return { gasPrice };
  }

  // For non-legacy (type2), round the priority fee up to the floor.
  const flooredPriorityFeePerGas = parseUnits(process.env[`MIN_PRIORITY_FEE_PER_GAS_${chainId}`] || "0", 9);
  maxPriorityFeePerGas = sdkUtils.bnMax(maxPriorityFeePerGas, flooredPriorityFeePerGas);

  // Update the max fee with the delta applied to the priority fee.
  let maxFeeDelta = maxPriorityFeePerGas.sub(gas.maxPriorityFeePerGas);
  maxFeePerGas = maxFeePerGas.add(maxFeeDelta);

  // For retryScaler > 1, transaction replacement is being attempted. Scale up the
  // max fee by retryScaler and allocate the entire delta to the priority fee.
  maxFeeDelta = computeFeeDelta(maxFeePerGas);
  maxFeePerGas = maxFeePerGas.add(maxFeeDelta);
  maxPriorityFeePerGas = maxPriorityFeePerGas.add(maxFeeDelta);

  return {
    maxFeePerGas,
    maxPriorityFeePerGas,
  };
}
