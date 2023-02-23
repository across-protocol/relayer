/* eslint-disable no-process-exit */
import { PoolRebalanceLeaf } from "../src/interfaces";
import {
  ethers,
  getSigner,
  RelayerRefundLeaf,
  MerkleTree,
  buildRelayerRefundTree,
  EMPTY_MERKLE_ROOT,
  SpokePool,
  toBNWei,
  toBN,
  Contract,
  getProvider,
  ERC20,
  fromWei,
  assert,
} from "../src/utils";

function tuplelifyLeaf(leaf: Object) {
  return JSON.stringify(
    Object.values(leaf).map((x: any) => (Array.isArray(x) ? x.map((y: any) => y.toString()) : x.toString()))
  );
}

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
  const baseSigner = await getSigner();

  // 1. Construct relayer refund leaves
  const leaves: Omit<RelayerRefundLeaf, "leafId">[] = [];
  leaves.push({
    amountToReturn: toBNWei("0.45674436", 8),
    chainId: 1,
    refundAmounts: [],
    l2TokenAddress: "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599",
    refundAddresses: [],
  });
  leaves.push({
    amountToReturn: toBNWei("1587.401398715879062171", 18),
    chainId: 1,
    refundAmounts: [],
    l2TokenAddress: "0x6B175474E89094C44Da98b954EedeAC495271d0F",
    refundAddresses: [],
  });
  leaves.push({
    amountToReturn: toBNWei("42733.367282", 6),
    chainId: 1,
    refundAmounts: [],
    l2TokenAddress: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
    refundAddresses: [],
  });
  leaves.push({
    amountToReturn: toBNWei("1.763447503649071506", 18),
    chainId: 1,
    refundAmounts: [],
    l2TokenAddress: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
    refundAddresses: [],
  });
  leaves.push({
    amountToReturn: toBNWei("2022.794228859445360116", 18),
    chainId: 1,
    refundAmounts: [],
    l2TokenAddress: "0x42bBFa2e77757C645eeaAd1655E0911a7553Efbc",
    refundAddresses: [],
  });
  leaves.push({
    amountToReturn: toBNWei("72.965848445733437533", 18),
    chainId: 1,
    refundAmounts: [],
    l2TokenAddress: "0xba100000625a3754423978a60c9317c58a424e3D",
    refundAddresses: [],
  });
  leaves.push({
    amountToReturn: toBNWei("1091.606119570909698851", 18),
    chainId: 10,
    refundAmounts: [],
    l2TokenAddress: "0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1",
    refundAddresses: [],
  });
  leaves.push({
    amountToReturn: toBNWei("6.665920591710948615", 18),
    chainId: 10,
    refundAmounts: [],
    // Should this be 0xdeaddead or 0x420...6?
    l2TokenAddress: "0x4200000000000000000000000000000000000006",
    refundAddresses: [],
  });
  // SEND EXCESS STEMMING FROM INVALID BUNDLE TO RELAYER
  leaves.push({
    amountToReturn: toBN(0),
    chainId: 10,
    refundAmounts: [toBNWei("0.8964241", 8)],
    l2TokenAddress: "0x68f180fcCe6836688e9084f035309E29Bf0A2095",
    refundAddresses: ["0x428AB2BA90Eba0a4Be7aF34C9Ac451ab061AC010"],
  });
  // SEND EXCESS STEMMING FROM INVALID BUNDLE TO RELAYER
  leaves.push({
    amountToReturn: toBN(0),
    chainId: 10,
    refundAmounts: [toBNWei("310326.309091", 6)],
    l2TokenAddress: "0x7F5c764cBc14f9669B88837ca1490cCa17c31607",
    refundAddresses: ["0x428AB2BA90Eba0a4Be7aF34C9Ac451ab061AC010"],
  });
  leaves.push({
    amountToReturn: toBNWei("4.03142531974844432", 18),
    chainId: 10,
    refundAmounts: [],
    l2TokenAddress: "0xFE8B128bA8C78aabC59d4c64cEE7fF28e9379921",
    refundAddresses: [],
  });
  leaves.push({
    amountToReturn: toBNWei("164.85174484068705566", 18),
    chainId: 137,
    refundAmounts: [],
    l2TokenAddress: "0x8f3Cf7ad23Cd3CaDbD9735AFf958023239c6A063",
    refundAddresses: [],
  });
  leaves.push({
    amountToReturn: toBNWei("8.363459", 6),
    chainId: 137,
    refundAmounts: [],
    l2TokenAddress: "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174",
    refundAddresses: [],
  });
  leaves.push({
    amountToReturn: toBNWei("9.151600491082717287", 18),
    chainId: 137,
    refundAmounts: [],
    l2TokenAddress: "0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619",
    refundAddresses: [],
  });
  leaves.push({
    amountToReturn: toBNWei("1.86687646", 8),
    chainId: 137,
    refundAmounts: [],
    l2TokenAddress: "0x1BFD67037B42Cf73acF2047067bd4F2C47D9BfD6",
    refundAddresses: [],
  });
  leaves.push({
    amountToReturn: toBNWei("2.264516396746117007", 18),
    chainId: 288,
    refundAmounts: [],
    l2TokenAddress: "0xDeadDeAddeAddEAddeadDEaDDEAdDeaDDeAD0000",
    refundAddresses: [],
  });
  leaves.push({
    amountToReturn: toBNWei("381.899084", 6),
    chainId: 288,
    refundAmounts: [],
    l2TokenAddress: "0x66a2A913e447d6b4BF33EFbec43aAeF87890FBbc",
    refundAddresses: [],
  });
  leaves.push({
    amountToReturn: toBNWei("0.00722599", 8),
    chainId: 42161,
    refundAmounts: [],
    l2TokenAddress: "0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f",
    refundAddresses: [],
  });
  leaves.push({
    amountToReturn: toBNWei("5.37277837995488542", 18),
    chainId: 42161,
    refundAmounts: [],
    l2TokenAddress: "0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1",
    refundAddresses: [],
  });
  leaves.push({
    amountToReturn: toBNWei("74.113581473486539887", 18),
    chainId: 42161,
    refundAmounts: [],
    l2TokenAddress: "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1",
    refundAddresses: [],
  });
  leaves.push({
    amountToReturn: toBNWei("5.446550283182134042", 18),
    chainId: 42161,
    refundAmounts: [],
    l2TokenAddress: "0x040d1EdC9569d4Bab2D15287Dc5A4F10F56a56B8",
    refundAddresses: [],
  });
  const relayerRefundLeaves = leaves.map((leaf, i) => {
    return {
      ...leaf,
      leafId: i,
    };
  });

  const relayerRefundRoot: MerkleTree<RelayerRefundLeaf> = buildRelayerRefundTree(relayerRefundLeaves);
  console.log("relayerRefundRoot:", prettyRelayerRefundLeaf(relayerRefundLeaves), relayerRefundRoot.getHexRoot());

  for (let i = 0; i < relayerRefundLeaves.length; i++) {
    const l2Token = new Contract(
      relayerRefundLeaves[i].l2TokenAddress,
      ERC20.abi,
      getProvider(relayerRefundLeaves[i].chainId)
    );
    const [decimals, symbol] = await Promise.all([l2Token.decimals(), l2Token.symbol()]);
    console.group(`RelayerRefundLeaf ID#${i}`);
    console.log(`- Chain ID: ${relayerRefundLeaves[i].chainId}`);
    console.log(`- Amount to return: ${fromWei(relayerRefundLeaves[i].amountToReturn.toString(), decimals)} ${symbol}`);
    if (relayerRefundLeaves[i].refundAddresses.length > 0) {
      assert.equal(relayerRefundLeaves[i].refundAddresses.length, relayerRefundLeaves[i].refundAmounts.length);
      for (let j = 0; j < relayerRefundLeaves[i].refundAddresses.length; j++) {
        console.log(
          `- Refunding ${fromWei(relayerRefundLeaves[i].refundAmounts[j].toString(), decimals)} ${symbol} to ${
            relayerRefundLeaves[i].refundAddresses[j]
          }`
        );
      }
    }
    console.log(`- Proof for leaf ID#${i}: `, relayerRefundRoot.getHexProof(relayerRefundLeaves[i]));
    console.log(
      "- Tuple representation of leaf that you can input into etherscan.io: \n",
      tuplelifyLeaf(relayerRefundLeaves[i])
    );
    console.groupEnd();
  }

  // 2. Get ABI encoded function signature to relay roots to spoke pools:
  // The following address is the Optimism_SpokePool but could be any chain's SpokePool.
  const spokePool = new ethers.Contract("0xa420b2d1c0841415a695b81e5b867bcd07dff8c9", SpokePool.abi, baseSigner);
  const abiEncodedFunctionData = spokePool.interface.encodeFunctionData("relayRootBundle", [
    relayerRefundRoot.getHexRoot(),
    EMPTY_MERKLE_ROOT,
  ]);
  console.log("abiEncodedFunctionData", abiEncodedFunctionData);
  console.log("Relayer refund merkle root", relayerRefundRoot.getHexRoot())

  // // 3. Construct pool rebalance leaves
  // const poolRebalanceLeaves: PoolRebalanceLeaf[] = [
  //   {
  //     chainId: 1,
  //     bundleLpFees: [toBN("124122273836729709").sub(toBN("123603942018663986"))],
  //     netSendAmounts: [toBN("120200463420953608591").sub(toBN("119648808743556644079"))],
  //     runningBalances: [toBN(0)],
  //     groupIndex: 0,
  //     leafId: 0,
  //     l1Tokens: ["0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2"],
  //   },
  // ];
  // const relayerRefundLeaves2: RelayerRefundLeaf[] = [
  //   {
  //     amountToReturn: toBN(0),
  //     chainId: 1,
  //     refundAmounts: [toBN("132101928812168900443").sub(toBN("131550274134771935931"))],
  //     leafId: 0,
  //     l2TokenAddress: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
  //     refundAddresses: ["0x428AB2BA90Eba0a4Be7aF34C9Ac451ab061AC010"],
  //   },
  // ];
  // const poolRebalanceRoot: MerkleTree<PoolRebalanceLeaf> = buildPoolRebalanceLeafTree(poolRebalanceLeaves);

  // const relayerRefundRoot2: MerkleTree<RelayerRefundLeaf> = buildRelayerRefundTree(relayerRefundLeaves2);
  // console.log("relayerRefundRoot2:", prettyRelayerRefundLeaf(relayerRefundLeaves2), relayerRefundRoot2.getHexRoot());
  // console.log("poolRebalanceRoot:", prettyPoolRebalanceLeaf(poolRebalanceLeaves), poolRebalanceRoot.getHexRoot());
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
