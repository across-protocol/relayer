import { ethers, Contract, CHAIN_IDs, ZERO_ADDRESS, isDefined } from "../src/utils";
import { CONTRACT_ADDRESSES } from "../src/common/ContractAddresses";
import { askYesNoQuestion } from "./utils";

import minimist from "minimist";
const args = minimist(process.argv.slice(2), {
  string: ["chainId", "function", "bridge"],
});

const { MAINNET } = CHAIN_IDs;

// The atomic depositor should not change on each new chain deployment.
const atomicDepositor = new Contract(
  CONTRACT_ADDRESSES[MAINNET].atomicDepositor.address,
  CONTRACT_ADDRESSES[MAINNET].atomicDepositor.abi
);

// Example run:
// ts-node ./scripts/updateAtomicDepositor.ts \
//   --chainId 480
//   --function "depositETHTo(address,uint32,bytes)"
//   --bridge 0x470458C91978D2d929704489Ad730DC3E3001113

export async function run(): Promise<void> {
  if (!Object.keys(args).includes("chainId")) {
    throw new Error("Define `chainId` as the chain you want to connect on");
  }
  if (!Object.keys(args).includes("function")) {
    throw new Error("Define `function` as the ETH deposit function the atomic depositor should call");
  }
  if (!Object.keys(args).includes("bridge")) {
    throw new Error("Define `bridge` as address of the canonical bridge which bridges raw ETH to L2");
  }
  const feeToken = isDefined(args.feeToken) ? args.feeToken : ZERO_ADDRESS;
  const gateway = isDefined(args.gateway) ? args.gateway : ZERO_ADDRESS;
  if (
    (feeToken !== ZERO_ADDRESS && gateway === ZERO_ADDRESS) ||
    (feeToken === ZERO_ADDRESS && gateway !== ZERO_ADDRESS)
  ) {
    throw new Error("One of the fee token or gateway cannot be defined while the other is not");
  }
  console.log(
    `Confirmation: target chain ID: ${args.chainId}, function: ${args.function}, bridge address: ${args.bridge}, bridge fee token ${feeToken}, bridge gateway: ${gateway}`
  );
  if (!(await askYesNoQuestion("Do these arguments match with your expectations?"))) {
    throw new Error("Exiting due to incorrect arguments");
  }
  const functionSignatureToWhitelist = ethers.utils.keccak256(ethers.utils.toUtf8Bytes(args.function)).slice(0, 10);

  // We need the bridge address still.
  console.log(
    `Call ${atomicDepositor.address} with chain ID ${args.chainId}, bridge ${args.bridge}, and function signature ${functionSignatureToWhitelist}`
  );
  const calldata = atomicDepositor.interface.encodeFunctionData("whitelistBridge", [
    args.chainId,
    [args.bridge, gateway, feeToken, functionSignatureToWhitelist],
  ]);
  console.log(`Alternatively, call ${atomicDepositor.address} directly with calldata ${calldata}`);
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
