import {
  ethers,
  retrieveSignerFromCLIArgs,
  RelayerRefundLeaf,
  toBN,
  getProvider,
  blockExplorerLink,
  getDeployedAddress,
  SpokePool,
} from "../src/utils";

// This script can be used to manually execute a single relayer refund leaf and it is specifically suited for
// copying a leaf's contents from the GCP console and executing it.

// INSTRUCTIONS:
// - run command: ts-node ./scripts/executeRefundLeaf.ts --wallet mnemonic
// - step 1: Copy GCP leaf into the following structure. You can do so by locating the relevant "Relayer refund leaf #"
//           log, like: "Relayer refund leaf #44", and clicking "Copy > Copy as JSON":
// - step 2: Enter in the `rootBundleId` associated with the merkle tree. We can improve this script in the future
//           by auto detecting this rootBundleId from the associated relayerRefundRoot executed on Mainnet.
const gcpCopiedRefundLeaf: any = {
  jsonPayload: {
    proof: [
      "0xce16123833b1460978dcc1283c5a11e1baef81d9cb3716d0ce71d8908cfe49cf",
      "0x6a46348dc6276e7863c755074a9ce12c03697dc77d10ba6837fe3c0894824bc0",
      "0xb2be601f331b94d8946e2a5da0e761e1168f3b690413b4088deb64634b725a28",
      "0xaeaa95d06f5ba7138546f9095327306a399e513258c6c09eb20e00ea44b442dd",
      "0xc78100d993ab0502cd58cb3d5b33936e686344ad94c09a5038cfcde487ec0bc5",
    ],
    at: "Dataworker#propose",
    "bot-identifier": "across-v2-dataworker",
    message: "Relayer refund leaf #44",
    leaf: {
      amountToReturn: "0",
      chainId: 7777777,
      refundAddresses: [
        "0xCad97616f91872C02BA3553dB315Db4015cBE850",
        "0x07aE8551Be970cB1cCa11Dd7a11F47Ae82e70E67",
        "0x1b59718eaFA2BFFE5318E07c1C3cB2edde354f9C",
      ],
      l2TokenAddress: "0x4200000000000000000000000000000000000006",
      leafId: 44,
      refundAmounts: ["26212000000000000", "9581000000000000", "1739000000000000"],
    },
  },
};

const rootBundleId = 5482;
export async function run(): Promise<void> {
  const baseSigner = await retrieveSignerFromCLIArgs();

  // Reformat leaf such that we can execute it on-chain:
  const relayerRefundLeaf: RelayerRefundLeaf = {
    ...gcpCopiedRefundLeaf.jsonPayload.leaf,
    refundAmounts: gcpCopiedRefundLeaf.jsonPayload.leaf.refundAmounts.map((x) => toBN(x)),
  };
  const connectedSigner = baseSigner.connect(await getProvider(Number(relayerRefundLeaf.chainId)));

  const spokePoolContract = getDeployedAddress("SpokePool", relayerRefundLeaf.chainId);
  const spokePool = new ethers.Contract(spokePoolContract, SpokePool.abi, connectedSigner);
  const txn = await spokePool.executeRelayerRefundLeaf(
    rootBundleId,
    relayerRefundLeaf,
    gcpCopiedRefundLeaf.jsonPayload.proof
    // @dev: Set the following variables if you're having trouble landing the transaction:
    // {
    //     maxPriorityFeePerGas: toGWei("30"),
    //     maxFeePerGas: toGWei("80"),
    //     nonce: 2453
    // }
  );
  console.log(
    `Submitted transaction with maxPriorityFeePerGas: ${txn.maxPriorityFeePerGas.toString()} and maxFeePerGas:${txn.maxFeePerGas.toString()}`
  );
  const receipt = await txn.wait();
  console.log("Receipt: ", receipt);
  const explorerUrl = blockExplorerLink(receipt.transactionHash, relayerRefundLeaf.chainId);
  console.log(`Block explorer URL: ${explorerUrl}`);
}

if (require.main === module) {
  run()
    .then(async () => {
      // eslint-disable-next-line no-process-exit
      process.exit(0);
    })
    .catch(async (error) => {
      console.error("Process exited with", error);
      // eslint-disable-next-line no-process-exit
      process.exit(1);
    });
}
