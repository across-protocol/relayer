import { Contract, Signer } from "ethers";
import { WETH9__factory as WETH9 } from "@across-protocol/contracts";
import { AugmentedTransaction, TransactionClient } from "../clients";
import {
  BigNumber,
  bnUint256Max,
  bnZero,
  formatEther,
  getNetworkName,
  isDefined,
  Provider,
  TransactionReceipt,
  winston,
} from "../utils";

export class Disputer {
  protected bondToken: Contract;
  protected bondAmount: BigNumber;
  protected bondMultiplier: { min: number; target: number };
  protected provider: Provider;
  protected txnClient: TransactionClient;
  protected chain: string;
  private initPromise: Promise<void>;

  constructor(
    protected readonly chainId: number,
    protected readonly logger: winston.Logger,
    protected readonly hubPool: Contract,
    readonly signer: Signer,
    protected readonly simulate = true
  ) {
    this.chain = getNetworkName(chainId);
    this.provider = hubPool.provider;
    // signer.connect() is unsupported in test.
    this.signer = signer.provider
      ? signer
      : signer.connect(hubPool.provider);
    this.bondMultiplier = {
      min: 4,
      target: 8,
    };
    this.txnClient = new TransactionClient(this.logger);

    const initPromise = async () => {
      // @todo: Optimise all calls here by using Multicall3 to query:
      // - bondToken
      // - bondAmount
      // - native balance
      const [bondToken, bondAmount] = await Promise.all([this.hubPool.bondToken(), this.hubPool.bondAmount()]);
      this.bondToken = WETH9.connect(bondToken, this.signer);
      this.bondAmount = bondAmount;
    };
    this.initPromise = initPromise();
  }

  async validate(): Promise<void> {
    await this.initPromise;

    const { bondAmount, logger } = this;
    const minBondAmount = bondAmount.mul(this.bondMultiplier.min);

    // Balance checks.
    const balance = await this.balance();
    const mintAmount = minBondAmount.sub(balance);
    if (mintAmount.gt(bnZero)) {
      const nativeBalance = await this.provider.getBalance(await this.signer.getAddress());
      if (nativeBalance.gt(mintAmount)) {
        await this.mintBond(mintAmount);
      } else {
        const fmtAmount = formatEther(mintAmount);
        const message = `Insufficient native token balance to mint ${fmtAmount} bond tokens.`;
        if (!this.simulate && balance.lt(bondAmount)) {
          throw new Error(message);
        }
        logger.warn({ at: "Disputer::validate", message, nativeBalance, mintAmount });
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

  async approve(amount = bnUint256Max): Promise<TransactionReceipt | undefined> {
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
    };

    return this.submit(txn);
  }

  async mintBond(amount: BigNumber): Promise<TransactionReceipt | undefined> {
    const { chainId, bondToken } = this;
    const txn = {
      chainId,
      contract: bondToken,
      method: "deposit",
      args: [],
      message: `Minted ${amount} HubPool bondToken.`,
      value: amount,
      unpermissioned: false,
      canFailInSimulation: false,
      nonMulticall: true,
    };

    return this.submit(txn);
  }

  dispute(): Promise<TransactionReceipt | undefined> {
    const { chainId, hubPool } = this;
    const txn = {
      chainId,
      contract: hubPool.connect(this.signer),
      method: "disputeRootBundle",
      args: [],
      message: "Disputed HubPool root bundle proposal.",
      unpermissioned: false,
      canFailInSimulation: false,
      nonMulticall: true,
    };

    try {
      return this.submit(txn);
    } catch (err) {
      this.logger.error({ at: "Disputer::dispute", message: "Failed to submit HubPool dispute.", err });
    }

    return Promise.resolve(undefined);
  }

  protected async submit(txn: AugmentedTransaction, maxTries = 3): Promise<TransactionReceipt | undefined> {
    const { chainId, logger, txnClient } = this;

    if (this.simulate) {
      logger.warn({ at: "Disputer::submit", message: `Suppressing ${txn.method} transaction.` });
      return Promise.resolve(undefined);
    }

    let txnReceipt: TransactionReceipt;
    let cause: unknown;
    let tries = 0;

    do {
      try {
        const [txnResponse] = await txnClient.submit(chainId, [txn]);
        txnReceipt = await txnResponse.wait();
        return txnReceipt;
      } catch (err: unknown) {
        cause = err;
      }
    } while (!isDefined(txnReceipt) && ++tries < maxTries);

    throw new Error(`Unable to submit transaction on ${this.chain}`, { cause });
  }
}
