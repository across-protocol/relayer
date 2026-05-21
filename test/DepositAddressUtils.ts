import { expect } from "chai";
import { CHAIN_IDs, getEthersCompatibleAddress, toAddressType } from "../src/utils";
import { getDepositKey, normalizeDepositAddressMessage } from "../src/utils/DepositAddressUtils";
import { DepositAddressMessage } from "../src/interfaces/DepositAddress";

/** Indexer API sample: Tron origin, Base destination, USDT correct_transfer. */
function tronOriginIndexerMessage(): DepositAddressMessage {
  return {
    depositAddress: "TRiKGHiWuKvDjwgNTmi6ohsucSfLBoLAVu",
    salt: "0x62107e6c5f0b540727bc61b879860861f24776196f3ab870e04209a8aa9310e0",
    routeParams: {
      recipient: "0x9A8f92a830A5cB89a3816e3D267CB7791c16b04D",
      inputToken: "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t",
      outputToken: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      originChainId: String(CHAIN_IDs.TRON),
      refundAddress: "TQ4T4DgHoezYBTRoZPCspsSgRw38Ni9prA",
      destinationChainId: String(CHAIN_IDs.BASE),
    },
    paramsHash: "0xae46ff5ee16dc02f97b82c4a450b032ad0b01d9459a3055b4519331607a6857f",
    counterfactualDepositContractAddress: "0xc84198579ed4FB968c651B4eBFA3fF54cE991bf9",
    counterfactualFactoryContractAddress: "0xBE77a40E4Dc0b6255FA68b65D553Ae10E46F6fEb",
    adminWithdrawManagerContractAddress: "0xC593A2A4ff1F65f652C67cEB4175502E75e87EbD",
    shouldSponsorAccountCreation: false,
    counterfactualMaterials: {
      withdrawLeaf: {
        leafHash: "0x19ecbddda68254998f2d2dfe9d5410e1ae2237711988a7e96a3ddeb0063aec9d",
        merkleProof: [
          "0x2b9919ef937741fe6214e3f1174b57642806d79a14ed100f2b74b47645e76f9f",
          "0x7926eef0d29d7beca7b09509258b03b91decd1c601e0fb33ebfc72202eab1d07",
        ],
        encodedParams:
          "0x000000000000000000000000c593a2a4ff1f65f652c67ceb4175502e75e87ebd0000000000000000000000009a8f92a830a5cb89a3816e3d267cb7791c16b04d",
        implementationAddress: "0x51506Bb64295228CF6FE8F6C88301Be45b7C1AB6",
      },
    },
    erc20Transfer: {
      chainId: String(CHAIN_IDs.TRON),
      from: "TQ4T4DgHoezYBTRoZPCspsSgRw38Ni9prA",
      to: "TRiKGHiWuKvDjwgNTmi6ohsucSfLBoLAVu",
      amount: "500000",
      contractAddress: "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t",
      transactionHash: "0x15a6186852bc5c0138add0d0d55993cbf5d85472e8d51f7dc3d23da1f870b88d",
      transferClassification: "correct_transfer",
    },
  };
}

const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;

describe("DepositAddressUtils", function () {
  it("normalizeDepositAddressMessage converts Tron indexer base58 fields to ethers hex", function () {
    const raw = tronOriginIndexerMessage();
    const normalized = normalizeDepositAddressMessage(raw);

    expect(normalized.depositAddress).to.match(EVM_ADDRESS);
    expect(normalized.depositAddress).to.equal(getEthersCompatibleAddress(CHAIN_IDs.TRON, raw.depositAddress));
    expect(normalized.routeParams.inputToken).to.equal(
      getEthersCompatibleAddress(CHAIN_IDs.TRON, raw.routeParams.inputToken)
    );
    expect(normalized.routeParams.refundAddress).to.match(EVM_ADDRESS);
    expect(normalized.erc20Transfer.from).to.match(EVM_ADDRESS);
    expect(normalized.erc20Transfer.to).to.equal(normalized.depositAddress);
    expect(normalized.erc20Transfer.contractAddress).to.equal(normalized.routeParams.inputToken);

    // Base destination fields are already 0x and unchanged.
    expect(normalized.routeParams.recipient).to.equal(raw.routeParams.recipient);
    expect(normalized.routeParams.outputToken).to.equal(raw.routeParams.outputToken);

    // Counterfactual metadata already hex on origin; checksum may differ only.
    expect(normalized.counterfactualFactoryContractAddress.toLowerCase()).to.equal(
      raw.counterfactualFactoryContractAddress.toLowerCase()
    );

    // Unrelated fields preserved.
    expect(normalized.salt).to.equal(raw.salt);
    expect(normalized.paramsHash).to.equal(raw.paramsHash);
    expect(normalized.erc20Transfer.transactionHash).to.equal(raw.erc20Transfer.transactionHash);
    expect(normalized.erc20Transfer.amount).to.equal("500000");
  });

  it("toAddressType().toNative() returns chain-native strings for swap and withdraw API params", function () {
    const raw = tronOriginIndexerMessage();
    const normalized = normalizeDepositAddressMessage(raw);
    const originChainId = Number(normalized.routeParams.originChainId);
    const refundChainId = Number(normalized.erc20Transfer.chainId);

    // Swap API (Tron origin).
    expect(toAddressType(normalized.depositAddress, originChainId).toNative()).to.equal(raw.depositAddress);
    expect(toAddressType(normalized.routeParams.inputToken, originChainId).toNative()).to.equal(
      raw.routeParams.inputToken
    );
    expect(toAddressType(normalized.routeParams.refundAddress, originChainId).toNative()).to.equal(
      raw.routeParams.refundAddress
    );
    expect(toAddressType(normalized.routeParams.recipient, CHAIN_IDs.BASE).toNative()).to.equal(
      normalized.routeParams.recipient
    );

    // Signed-withdraw API (Tron refund chain; origin matches for this fixture).
    expect(toAddressType(normalized.depositAddress, refundChainId).toNative()).to.equal(raw.depositAddress);
    expect(toAddressType(normalized.erc20Transfer.contractAddress, refundChainId).toNative()).to.equal(
      raw.erc20Transfer.contractAddress
    );
    expect(toAddressType(normalized.routeParams.refundAddress, originChainId).toNative()).to.equal(
      raw.routeParams.refundAddress
    );
    expect(
      toAddressType(normalized.counterfactualMaterials.withdrawLeaf.implementationAddress, originChainId).toNative()
    ).to.match(/^T/);
  });

  it("getDepositKey uses normalized deposit address after indexer remap", function () {
    const raw = tronOriginIndexerMessage();
    const normalized = normalizeDepositAddressMessage(raw);

    expect(getDepositKey(normalized)).to.equal(`${normalized.depositAddress}:${raw.erc20Transfer.transactionHash}`);
    expect(getDepositKey(normalized)).to.not.equal(getDepositKey(raw));
  });
});
