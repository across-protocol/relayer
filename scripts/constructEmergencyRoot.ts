import { sortRelayerRefundLeaves } from "../src/dataworker/RelayerRefundUtils";
import {
  ethers,
  getSigner,
  RelayerRefundLeaf,
  MerkleTree,
  buildRelayerRefundTree,
  EMPTY_MERKLE_ROOT,
  SpokePool
} from "../src/utils";

// This script can be used to generate a manual merkle root and is filled with example data.
export async function run(): Promise<void> {
  const baseSigner = await getSigner();

  // 1. Construct relayer refund leaves
  const relayerRefundLeaves: any[] = [
    {
      amountToReturn: "500000000000000000000",
      chainId: 10,
      refundAmounts: [],
      leafId: 1,
      l2TokenAddress: "0x4200000000000000000000000000000000000006",
      refundAddresses: [],
    },
  ];

  const relayerRefundRoot: MerkleTree<RelayerRefundLeaf> = buildRelayerRefundTree(
    sortRelayerRefundLeaves(relayerRefundLeaves)
  );
  console.log(relayerRefundLeaves, relayerRefundRoot.getHexRoot());

  // 2. Get ABI encoded function signature to relay roots to spoke pools:
  // The following address is the Optimism_SpokePool but could be any chain's SpokePool.
  const spokePool = new ethers.Contract("0xa420b2d1c0841415a695b81e5b867bcd07dff8c9", SpokePool.abi, baseSigner);
  const abiEncodedFunctionData = spokePool.interface.encodeFunctionData("relayRootBundle", [
    relayerRefundRoot.getHexRoot(),
    EMPTY_MERKLE_ROOT,
  ]);
  console.log(abiEncodedFunctionData);
}

if (require.main === module) {
  run()
    .then(async () => {
      process.exit(0);
    })
    .catch(async (error) => {
      console.error("Process exited with", error);
      process.exit(1);
    });
}
