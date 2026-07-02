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
  toBNWei,
  TransactionResponse,
  submitTransaction,
  Provider,
  winston,
} from "../utils";

// Absolute bond token balance maintenance levels (18 decimals). When the balance drops below
// trigger, native token is wrapped to restore the balance to target. Unset values fall back to
// bondMultiplier-based defaults derived from the HubPool bond amount.
export type BondReserve = { trigger?: BigNumber; target?: BigNumber };

export class Disputer {
  private _bondToken?: Contract;
  protected bondAmount = bnZero;
  protected bondMultiplier: { min: number; target: number };
  // Native balance is never wrapped below this level; the mint/approve/dispute transactions
  // themselves need gas.
  protected nativeGasReserve = toBNWei("0.5");
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
    protected readonly bondReserve: BondReserve = {}
  ) {
    this.chain = getNetworkName(chainId);
    this.provider = hubPool.provider;
    // signer.connect() is unsupported in test.
    this.signer = signer.provider ? signer : signer.connect(hubPool.provider);
    this.bondMultiplier = {
      min: 4,
      target: 8,
    };
    this.txnClient = new TransactionClient(this.logger);
    this.initPromise = this._getOrCreateInitPromise();
  }

  async validate(): Promise<void> {
    await this._getOrCreateInitPromise();

    const { bondAmount, bondReserve, logger } = this;
    const minBondAmount = bondReserve.trigger ?? bondAmount.mul(this.bondMultiplier.min);
    let targetBondAmount = bondReserve.target ?? bondAmount.mul(this.bondMultiplier.target);
    if (targetBondAmount.lt(minBondAmount)) {
      targetBondAmount = minBondAmount;
    }

    // Balance checks. Top up to target when the balance drops below the trigger, wrapping as much
    // of any shortfall as the native balance permits.
    const balance = await this.balance();
    if (balance.lt(minBondAmount)) {
      const nativeBalance = await this.provider.getBalance(await this.signer.getAddress());
      const shortfall = targetBondAmount.sub(balance);
      const available = nativeBalance.sub(this.nativeGasReserve);
      const mintAmount = shortfall.lte(available) ? shortfall : available;
      if (mintAmount.gt(bnZero)) {
        await this.mintBond(mintAmount);
      }
      if (mintAmount.lt(shortfall)) {
        const minted = mintAmount.gt(bnZero) ? mintAmount : bnZero;
        const fmtAmount = formatEther(shortfall.sub(minted));
        const message = `Insufficient native token balance to mint ${fmtAmount} bond tokens.`;
        if (!this.simulate && balance.add(minted).lt(bondAmount)) {
          throw new Error(message);
        }
        logger.warn({ at: "Disputer::validate", message, nativeBalance, shortfall, minted });
      }
    }

    // Ensure allowances are in place.
    const allowance = await this.allowance();
    if (allowance.lt(targetBondAmount)) {
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
