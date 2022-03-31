import { deposit, Contract, SignerWithAddress, fillRelay, BigNumber } from "./index";
import { amountToDeposit } from "../constants";
import { Deposit, Fill } from "../../src/interfaces/SpokePool";
import { toBNWei } from "../../src/utils";
import { HubPoolClient, RateModelClient } from "../../src/clients";

export async function buildDeposit(
  rateModelClient: RateModelClient,
  hubPoolClient: HubPoolClient,
  spokePool: Contract,
  tokenToDeposit: Contract,
  l1TokenForDepositedToken: Contract,
  recipient: SignerWithAddress,
  depositor: SignerWithAddress,
  _destinationChainId: number,
  _amountToDeposit: BigNumber = amountToDeposit
): Promise<Deposit> {
  const _deposit = await deposit(
    spokePool,
    tokenToDeposit,
    recipient,
    depositor,
    _destinationChainId,
    _amountToDeposit
  );
  return {
    ..._deposit,
    destinationToken: hubPoolClient.getDestinationTokenForDeposit(_deposit),
    realizedLpFeePct: await rateModelClient.computeRealizedLpFeePct(_deposit, l1TokenForDepositedToken.address),
  };
}

export async function buildFill(
  spokePool: Contract,
  destinationToken: Contract,
  recipient: SignerWithAddress,
  depositor: SignerWithAddress,
  relayer: SignerWithAddress,
  deposit: Deposit,
  pctOfDepositToFill: number
): Promise<Fill> {
  return await fillRelay(
    spokePool,
    destinationToken,
    recipient,
    depositor,
    relayer,
    deposit.depositId,
    deposit.originChainId,
    deposit.amount,
    deposit.amount.mul(toBNWei(pctOfDepositToFill)).div(toBNWei(1)),
    deposit.realizedLpFeePct,
    deposit.relayerFeePct
  );
}
