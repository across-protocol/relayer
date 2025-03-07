import assert from "assert";
import {
  Contract,
  BigNumber,
  Signer,
  EventSearchConfig,
  Provider,
  ethers,
  TOKEN_SYMBOLS_MAP,
  compareAddressesSimple,
  paginatedEventQuery,
  ZERO_BYTES,
  isContractDeployedToAddress,
} from "../../utils";
import { processEvent, matchL2EthDepositAndWrapEvents } from "../utils";
import { CONTRACT_ADDRESSES } from "../../common";
import { BridgeTransactionDetails, BaseBridgeAdapter, BridgeEvents } from "./BaseBridgeAdapter";
import * as zksync from "zksync-ethers";
import { gasPriceOracle } from "@across-protocol/sdk";
import { PUBLIC_NETWORKS } from "@across-protocol/constants";

/* For both the canonical bridge (this bridge) and the ZkStackWethBridge
 * bridge, we need to assume that the l1 and l2 signers contain
 * associated providers, since we need to get information about
 * addresses and gas prices (this is also why `constructL1toL2Txn`
 * is an async fn).
 */
export class ZKStackBridge extends BaseBridgeAdapter {
  readonly gasPerPubdataLimit = zksync.utils.REQUIRED_L1_TO_L2_GAS_PER_PUBDATA_LIMIT;
  readonly l2GasLimit = BigNumber.from(2_000_000);
  readonly sharedBridgeAddress: string;
  readonly l2GasToken: Contract;
  readonly l2WrappedGasToken: Contract;
  readonly hubPool: Contract;
  readonly tokenVault: Contract;

  constructor(
    l2chainId: number,
    hubChainId: number,
    l1Signer: Signer,
    l2SignerOrProvider: Signer | Provider,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _l1Token: string
  ) {
    const sharedBridgeAddress = CONTRACT_ADDRESSES[hubChainId][`zkStackSharedBridge_${l2chainId}`].address;
    super(l2chainId, hubChainId, l1Signer, l2SignerOrProvider, [sharedBridgeAddress]);

    const nativeToken = PUBLIC_NETWORKS[l2chainId].nativeToken;
    // Only set nonstandard gas tokens.
    if (nativeToken !== "ETH") {
      this.gasToken = TOKEN_SYMBOLS_MAP[nativeToken].addresses[hubChainId];
    }

    const { address: l1Address, abi: l1Abi } = CONTRACT_ADDRESSES[hubChainId].zkStackBridgeHub;
    this.l1Bridge = new Contract(l1Address, l1Abi, l1Signer);

    this.sharedBridgeAddress = sharedBridgeAddress;

    const { address: l2Address, abi: l2Abi } = CONTRACT_ADDRESSES[l2chainId].zkStackBridge;
    this.l2Bridge = new Contract(l2Address, l2Abi, l2SignerOrProvider);

    // This bridge treats hub pool transfers differently from EOA rebalances, so we must know the hub pool address.
    const { address: hubPoolAddress, abi: hubPoolAbi } = CONTRACT_ADDRESSES[hubChainId].hubPool;
    this.hubPool = new Contract(hubPoolAddress, hubPoolAbi);

    // We need the L2 gas token contract for ZkStack since this contract mints directly to the recipient
    // when a bridge is completed.
    const { address: l2GasTokenAddress, abi: l2GasTokenAbi } = CONTRACT_ADDRESSES[l2chainId].gasToken;
    const { address: l2WrappedGasTokenAddress, abi: l2WrappedGasTokenAbi } =
      CONTRACT_ADDRESSES[l2chainId].wrappedGasToken;
    this.l2GasToken = new Contract(l2GasTokenAddress, l2GasTokenAbi, l2SignerOrProvider);
    this.l2WrappedGasToken = new Contract(l2WrappedGasTokenAddress, l2WrappedGasTokenAbi, l2SignerOrProvider);

    // The contract which emits the bridge events we wish to track is the L1NativeTokenVault.
    const { address: tokenVaultAddress, abi: tokenVaultAbi } =
      CONTRACT_ADDRESSES[hubChainId][`nativeTokenVault_${l2chainId}`];
    this.tokenVault = new Contract(tokenVaultAddress, tokenVaultAbi, l1Signer);
  }

  async constructL1ToL2Txn(
    toAddress: string,
    l1Token: string,
    l2Token: string,
    amount: BigNumber
  ): Promise<BridgeTransactionDetails> {
    // The zkStack bridges need to know the l2 gas price bid beforehand. If this bid is too small, the transaction will revert.
    const txBaseCost = await this._txBaseCost();
    const secondBridgeCalldata = this._secondBridgeCalldata(toAddress, l1Token, amount);

    // The method/arguments change depending on whether or not we are bridging the gas token or another ERC20.
    const bridgingGasToken = l1Token === this.gasToken;
    const method = bridgingGasToken ? "requestL2TransactionDirect" : "requestL2TransactionTwoBridges";
    const args = bridgingGasToken
      ? [
          [
            this.l2chainId,
            txBaseCost.add(amount),
            toAddress,
            amount,
            "0x",
            this.l2GasLimit,
            this.gasPerPubdataLimit,
            [],
            toAddress,
          ],
        ]
      : [
          [
            this.l2chainId,
            txBaseCost,
            0,
            this.l2GasLimit,
            this.gasPerPubdataLimit,
            toAddress,
            this.sharedBridgeAddress,
            0,
            secondBridgeCalldata,
          ],
        ];

    return {
      contract: this.getL1Bridge(),
      method,
      args,
    };
  }

  async queryL1BridgeInitiationEvents(
    l1Token: string,
    fromAddress: string,
    toAddress: string,
    eventConfig: EventSearchConfig
  ): Promise<BridgeEvents> {
    // If the fromAddress is the hub pool then ignore the query. This is because for calculating cross-chain
    // transfers, we query both the hub pool outstanding transfers *and* the spoke pool outstanding transfers,
    // meaning that querying this function for the hub pool as well would effectively double count the outstanding transfer amount.
    if (compareAddressesSimple(fromAddress, this.hubPool.address)) {
      return {};
    }

    // Logic changes based on whether we are sending tokens to the spoke pool or to an EOA.
    const isL2Contract = await this._isContract(toAddress, this.getL2Bridge().provider!);
    let processedEvents;
    // If we are sending tokens to an L2 contract, then we can just look at the hub pool tokens relayed function since we assume the hub pool is sending tokens to the spoke pool.
    if (isL2Contract) {
      processedEvents = (await paginatedEventQuery(this.hubPool, this.hubPool.filters.TokensRelayed(), eventConfig))
        .filter((e) => compareAddressesSimple(e.args.to, toAddress) && compareAddressesSimple(e.args.l1Token, l1Token))
        .map((e) => {
          return {
            ...processEvent(e, "amount", "to", "to"),
            from: this.hubPool.address,
          };
        });
    } else {
      // Otherwise, we will need to query the token vault directly. We are either bridging an ERC20 token or the custom gas token.
      // The bridge contract does not emit the address of the token -- it instead emits an asset ID string, which we
      // must query from the l1TokenVault contract.
      const assetId = await this.tokenVault.assetId(l1Token);
      assert(assetId !== ZERO_BYTES); // Assert the asset id we are querying is supported by the bridge.

      processedEvents = (
        await paginatedEventQuery(
          this.tokenVault,
          this.tokenVault.filters.BridgeBurn(this.l2chainId, assetId, fromAddress),
          eventConfig
        )
      ).map((e) => processEvent(e, "amount", "receiver", "sender"));
    }
    return {
      [this.resolveL2TokenAddress(l1Token)]: processedEvents,
    };
  }

  async queryL2BridgeFinalizationEvents(
    l1Token: string,
    fromAddress: string,
    toAddress: string,
    eventConfig: EventSearchConfig
  ): Promise<BridgeEvents> {
    // Ignore hub pool queries for the same reason as above.
    if (compareAddressesSimple(fromAddress, this.hubPool.address)) {
      return {};
    }
    const bridgingGasToken = l1Token === this.gasToken;

    // Optionally alias the l1 sender.
    const isL1Contract = await this._isContract(fromAddress, this.getL1Bridge().provider!);
    const aliasedSender = isL1Contract ? zksync.utils.applyL1ToL2Alias(fromAddress) : fromAddress;
    let processedEvents;
    if (!bridgingGasToken) {
      processedEvents = await paginatedEventQuery(
        this.l2GasToken,
        this.l2GasToken.filters.Transfer(aliasedSender, toAddress),
        eventConfig
      );
    } else {
      // We unfortunately can't assume that the wrapped native token will emit an event when minting new tokens (i.e. a Transfer from the zero address), so we instead query the transfer of the native token to the wrapped native token contract.
      const [events, wrapEvents] = await Promise.all([
        paginatedEventQuery(this.l2GasToken, this.l2GasToken.filters.Transfer(aliasedSender, toAddress), eventConfig),
        paginatedEventQuery(
          this.l2GasToken,
          this.l2GasToken.filters.Transfer(toAddress, this.l2WrappedGasToken.address),
          eventConfig
        ),
      ]);
      processedEvents = matchL2EthDepositAndWrapEvents(events, wrapEvents);
    }
    return {
      [this.resolveL2TokenAddress(l1Token)]: processedEvents.map((e) => processEvent(e, "_amount", "_to", "from")),
    };
  }

  _secondBridgeCalldata(toAddress: string, l1Token: string, amount: BigNumber): string {
    return ethers.utils.defaultAbiCoder.encode(["address", "uint256", "address"], [l1Token, amount, toAddress]);
  }

  async _txBaseCost(): Promise<BigNumber> {
    const l1GasPriceData = await gasPriceOracle.getGasPriceEstimate(this.getL1Bridge().provider!);

    // Similar to the ZkSyncBridge types, we must calculate the l2 gas cost by querying a system contract. In this case,
    // the system contract to query is the bridge hub contract.
    const estimatedL1GasPrice = l1GasPriceData.maxPriorityFeePerGas.add(l1GasPriceData.maxFeePerGas);
    const l2Gas = await this.getL1Bridge().l2TransactionBaseCost(
      this.l2chainId,
      estimatedL1GasPrice,
      this.l2GasLimit,
      this.gasPerPubdataLimit
    );
    return l2Gas;
  }

  async _isContract(address: string, provider: Provider): Promise<boolean> {
    return isContractDeployedToAddress(address, provider);
  }
}
