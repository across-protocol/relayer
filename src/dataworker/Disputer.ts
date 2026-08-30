import { Contract, Signer } from "ethers";
import { WETH9__factory as WETH9 } from "@across-protocol/sdk/typechain";
import { AugmentedTransaction, TransactionClient } from "../clients";
import {
  assert,
  BigNumber,
  bnUint256Max,
  bnZero,
  formatEther,
  getNetworkName,
  isDefined,
  TransactionResponse,
  submitTransaction,
  Provider,
  toBNWei,
  winston,
} from "../utils";

// Native token held back from a bond mint, so gas remains for the approval and the dispute itself.
const GAS_RESERVE = toBNWei("0.05");

// Bond token holdings are maintained as a multiple of the HubPool bond amount: top up to `target` whenever the
// balance drops below `threshold`. Deployments needing a deeper buffer should raise these via configuration.
export type BondMultiplier = { threshold: number; target: number };
export const DEFAULT_BOND_MULTIPLIER: BondMultiplier = { threshold: 4, target: 8 };

export class Disputer {
  private _bondToken?: Contract;
  protected bondAmount = bnZero;
  protected bondMultiplier: BondMultiplier;
  protected provider: Provider;
  protected txnClient: TransactionClient;
  protected chain: string;
  private initPromise: Promise<void> | undefined;

  // bondToken is queried from HubPool during init(); reads pre-init throw, writes go through the setter.
  protected get bondToken(): Contract {
    assert(isDefined(this._bondToken), "Disputer: bondToken accessed before init() completed");
    return this._bondToken;
  }
  protected set bondToken(value: Contract) {
    this._bondToken = value;
  }

  constructor(
    protected readonly chainId: number,
    protected readonly logger: winston.Logger,
    protected readonly hubPool: Contract,
    readonly signer: Signer,
    protected readonly simulate = true,
    bondMultiplier: BondMultiplier = DEFAULT_BOND_MULTIPLIER
  ) {
    this.chain = getNetworkName(chainId);
    this.provider = hubPool.provider;
    // signer.connect() is unsupported in test.
    this.signer = signer.provider ? signer : signer.connect(hubPool.provider);
    const { threshold, target } = bondMultiplier;
    assert(threshold > 0 && target >= threshold, `Invalid bond multiplier (threshold ${threshold}, target ${target}).`);
    this.bondMultiplier = bondMultiplier;
    this.txnClient = new TransactionClient(this.logger);
    this.initPromise = this._getOrCreateInitPromise();
  }

  async validate(): Promise<void> {
    await this._getOrCreateInitPromise();

    const { bondAmount, logger } = this;
    const thresholdBondAmount = bondAmount.mul(this.bondMultiplier.threshold);

    // Balance checks. Mint up to the target multiple, otherwise the balance settles on its own threshold.
    const balance = await this.balance();
    if (balance.lt(thresholdBondAmount)) {
      const targetMintAmount = bondAmount.mul(this.bondMultiplier.target).sub(balance);
      const nativeBalance = await this.provider.getBalance(await this.signer.getAddress());

      // Top up to the target where affordable, otherwise mint what we can: a partial mint may still
      // cover the proposal in flight, whereas skipping it entirely strands the watchdog.
      const affordable = nativeBalance.gt(GAS_RESERVE) ? nativeBalance.sub(GAS_RESERVE) : bnZero;
      const mintAmount = targetMintAmount.lt(affordable) ? targetMintAmount : affordable;

      if (mintAmount.lt(targetMintAmount)) {
        const fmtAmount = formatEther(targetMintAmount);
        const message = `Insufficient native token balance to mint ${fmtAmount} bond tokens.`;
        // Only fatal if the topped-up balance still can't cover one dispute; bail before spending gas.
        if (!this.simulate && balance.add(mintAmount).lt(bondAmount)) {
          throw new Error(message);
        }
        logger.warn({ at: "Disputer::validate", message, nativeBalance, mintAmount, targetMintAmount });
      }

      if (mintAmount.gt(bnZero)) {
        await this.mintBond(mintAmount);
      }
    }

    // Ensure allowances are in place.
    const allowance = await this.allowance();
    const minAllowance = bondAmount.mul(this.bondMultiplier.target);
    if (allowance.lt(minAllowance)) {
      await this.approve();
    }
  }

  async balance(): Promise<BigNumber> {
    const disputer = await this.signer.getAddress();
    return this.bondToken.balanceOf(disputer);
  }

  async allowance(): Promise<BigNumber> {
    const signer = await this.signer.getAddress();
    return this.bondToken.allowance(signer, this.hubPool.address);
  }

  async approve(amount = bnUint256Max): Promise<TransactionResponse | undefined> {
    const { chainId, bondToken, hubPool } = this;
    const txn = {
      chainId,
      contract: bondToken,
      method: "approve",
      args: [hubPool.address, amount],
      message: "Approved HubPool to spend bondToken.",
      amount,
      unpermissioned: false,
      canFailInSimulation: false,
      nonMulticall: true,
      ensureConfirmation: true,
    };

    return this.submit(txn);
  }

  async mintBond(amount: BigNumber): Promise<TransactionResponse | undefined> {
    const { chainId, bondToken } = this;
    const txn = {
      chainId,
      contract: bondToken,
      method: "deposit",
      args: Array<unknown>(),
      message: `Minted ${amount} HubPool bondToken.`,
      value: amount,
      unpermissioned: false,
      canFailInSimulation: false,
      nonMulticall: true,
      ensureConfirmation: true,
    };

    return this.submit(txn);
  }

  dispute(): Promise<TransactionResponse | undefined> {
    const { chainId, hubPool } = this;
    const txn = {
      chainId,
      contract: hubPool.connect(this.signer),
      method: "disputeRootBundle",
      args: Array<unknown>(),
      message: "Disputed HubPool root bundle proposal.",
      unpermissioned: false,
      canFailInSimulation: false,
      nonMulticall: true,
      ensureConfirmation: true,
    };

    try {
      return this.submit(txn);
    } catch (err) {
      this.logger.error({ at: "Disputer::dispute", message: "Failed to submit HubPool dispute.", err });
    }

    return Promise.resolve(undefined);
  }

  protected async submit(txn: AugmentedTransaction): Promise<TransactionResponse | undefined> {
    const { logger } = this;

    if (this.simulate) {
      logger.warn({ at: "Disputer::submit", message: `Suppressing ${txn.method} transaction.` });
      return Promise.resolve(undefined);
    }

    return submitTransaction(txn, this.txnClient);
  }

  private _getOrCreateInitPromise(): Promise<void> {
    if (this.initPromise !== undefined) {
      return this.initPromise;
    }
    const promise = (async () => {
      // @todo: Optimise all calls here by using Multicall3 to query:
      // - bondToken
      // - bondAmount
      // - native balance
      const [bondToken, bondAmount] = await Promise.all([this.hubPool.bondToken(), this.hubPool.bondAmount()]);
      this._bondToken = WETH9.connect(bondToken, this.signer);
      this.bondAmount = bondAmount;
    })().catch((error) => {
      if (this.initPromise === promise) {
        this.initPromise = undefined;
      }
      throw error;
    });
    this.initPromise = promise;
    return promise;
  }
}
