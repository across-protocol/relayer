import { PoolRebalanceLeaf } from "../src/interfaces";
import {
  ethers,
  retrieveSignerFromCLIArgs,
  RelayerRefundLeaf,
  MerkleTree,
  buildRelayerRefundTree,
  EMPTY_MERKLE_ROOT,
  SpokePool,
  toBNWei,
  toBN,
  buildPoolRebalanceLeafTree,
  EvmAddress,
} from "../src/utils";

function prettyRelayerRefundLeaf(leaves: RelayerRefundLeaf[]) {
  return leaves.map((leaf) => {
    return {
      ...leaf,
      amountToReturn: leaf.amountToReturn.toString(),
      refundAmounts: leaf.refundAmounts.map((x) => x.toString()),
    };
  });
}
function prettyPoolRebalanceLeaf(leaves: PoolRebalanceLeaf[]) {
  return leaves.map((leaf) => {
    return {
      ...leaf,
      netSendAmounts: leaf.netSendAmounts.map((x) => x.toString()),
      runningBalances: leaf.runningBalances.map((x) => x.toString()),
      bundleLpFees: leaf.bundleLpFees.map((x) => x.toString()),
    };
  });
}
// This script can be used to generate a manual merkle root and is filled with example data.
export async function run(): Promise<void> {
  const baseSigner = await retrieveSignerFromCLIArgs();

  // 1. Construct relayer refund leaves
  const relayerRefundLeaves: RelayerRefundLeaf[] = [
    {
      amountToReturn: toBNWei("500"),
      chainId: 10,
      refundAmounts: [],
      leafId: 0,
      l2TokenAddress: EvmAddress.from("0x4200000000000000000000000000000000000006"),
      refundAddresses: [],
    },
  ];

  const relayerRefundRoot: MerkleTree<RelayerRefundLeaf> = buildRelayerRefundTree(relayerRefundLeaves);
  console.log(
    "relayerRefundRoot:",
    prettyRelayerRefundLeaf(relayerRefundLeaves),
    relayerRefundRoot.getHexRoot(),
    relayerRefundRoot.getHexProof(relayerRefundLeaves[0])
  );

  // 2. Get ABI encoded function signature to relay roots to spoke pools:
  // The following address is the Optimism_SpokePool but could be any chain's SpokePool.
  const spokePool = new ethers.Contract("0xa420b2d1c0841415a695b81e5b867bcd07dff8c9", SpokePool.abi, baseSigner);
  const abiEncodedFunctionData = spokePool.interface.encodeFunctionData("relayRootBundle", [
    relayerRefundRoot.getHexRoot(),
    EMPTY_MERKLE_ROOT,
  ]);
  console.log("abiEncodedFunctionData", abiEncodedFunctionData);

  // 3. Construct pool rebalance leaves
  const poolRebalanceLeaves: PoolRebalanceLeaf[] = [
    {
      chainId: 1,
      bundleLpFees: [toBN("124122273836729709").sub(toBN("123603942018663986"))],
      netSendAmounts: [toBN("120200463420953608591").sub(toBN("119648808743556644079"))],
      runningBalances: [toBN(0)],
      groupIndex: 0,
      leafId: 0,
      l1Tokens: [EvmAddress.from("0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2")],
    },
  ];
  const relayerRefundLeaves2: RelayerRefundLeaf[] = [
    {
      amountToReturn: toBN(0),
      chainId: 1,
      refundAmounts: [toBN("132101928812168900443").sub(toBN("131550274134771935931"))],
      leafId: 0,
      l2TokenAddress: EvmAddress.from("0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2"),
      refundAddresses: [EvmAddress.from("0x428AB2BA90Eba0a4Be7aF34C9Ac451ab061AC010")],
    },
  ];
  const poolRebalanceRoot: MerkleTree<PoolRebalanceLeaf> = buildPoolRebalanceLeafTree(poolRebalanceLeaves);

  const relayerRefundRoot2: MerkleTree<RelayerRefundLeaf> = buildRelayerRefundTree(relayerRefundLeaves2);
  console.log("relayerRefundRoot2:", prettyRelayerRefundLeaf(relayerRefundLeaves2), relayerRefundRoot2.getHexRoot());
  console.log("poolRebalanceRoot:", prettyPoolRebalanceLeaf(poolRebalanceLeaves), poolRebalanceRoot.getHexRoot());
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
