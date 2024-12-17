// Normally we avoid importing directly from a node_modules' /dist package but we need access to some
// of the internal classes and functions in order to replicate SDK logic so that we can by pass hardcoded
// ethers.Provider instances and use our own custom provider instead.
import { L1MessageServiceContract, L2MessageServiceContract } from "@consensys/linea-sdk/dist/lib/contracts";
import { L1ClaimingService } from "@consensys/linea-sdk/dist/lib/sdk/claiming/L1ClaimingService";
import { MessageSentEvent } from "@consensys/linea-sdk/dist/typechain/L2MessageService";
import { SparseMerkleTreeFactory } from "@consensys/linea-sdk/dist/lib/sdk/merkleTree/MerkleTreeFactory";
import {
  DEFAULT_L2_MESSAGE_TREE_DEPTH,
  L2_MERKLE_TREE_ADDED_EVENT_SIGNATURE,
  L2_MESSAGING_BLOCK_ANCHORED_EVENT_SIGNATURE,
} from "@consensys/linea-sdk/dist/lib/utils/constants";

export {
  L1ClaimingService,
  L1MessageServiceContract,
  L2MessageServiceContract,
  MessageSentEvent,
  SparseMerkleTreeFactory,
  DEFAULT_L2_MESSAGE_TREE_DEPTH,
  L2_MERKLE_TREE_ADDED_EVENT_SIGNATURE,
  L2_MESSAGING_BLOCK_ANCHORED_EVENT_SIGNATURE,
};
