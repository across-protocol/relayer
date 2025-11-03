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
  protected provider: Provider;
  protected txnClient: TransactionClient;
  protected bondMultiplier: { min: number; target: number };
  protected chain: string;

  constructor(
    protected readonly chainId: number,
    protected readonly logger: winston.Logger,
    protected readonly hubPool: Contract,
    protected readonly signer: Signer,
    protected readonly simulate = true
  ) {
    this.chain = getNetworkName(chainId);
    this.provider = hubPool.provider;
    this.bondMultiplier = {
      min: 4,
      target: 8,
    };
    this.txnClient = new TransactionClient(this.logger);
  }

  async init(): Promise<void> {
    // @todo: Optimise all calls here by using Multicall3 to query:
    // - bondToken
    // - bondAmount
    // - native balance
    const [bondToken, bondAmount] = await Promise.all([this.hubPool.bondToken(), this.hubPool.bondAmount()]);
    this.bondToken = WETH9.connect(bondToken, this.signer);

    const minBondAmount = bondAmount.mul(this.bondMultiplier.min);

    // Balance checks.
    const balance = await this.balance();
    const mintAmount = minBondAmount.sub(balance);
    if (mintAmount.gt(bnZero)) {
      const nativeBalance = await this.provider.getBalance(await this.signer.getAddress());
      if (nativeBalance.lte(mintAmount)) {
        const nativeAmount = formatEther(mintAmount);
        if (!this.simulate) {
          // @todo: Should alert if cannot mint, but should not error if there is sufficient to dispute.
          throw new Error(`Insufficient native token balance to mint ${nativeAmount} bond tokens`);
        }
      }
      await this.mintBond(mintAmount);
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

    return this.submit(txn);
  }

  protected async submit(txn: AugmentedTransaction, maxTries = 3): Promise<TransactionReceipt | undefined> {
    const { txnClient, chainId } = this;

    if (this.simulate) {
      this.logger.warn({ at: "Disputer::submit", message: `Suppressing ${txn.method} transaction.` });
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
