//SPDX-License-Identifier: Unlicense
pragma solidity ^0.8.0;

/**
 * @title MockFinalizationTarget
 * @notice Stands in for an L1 bridge/portal in finalizer pre-flight tests. Each entrypoint either succeeds
 * only when called via Multicall3, or fails in one of the ways the pre-flight has to tell apart.
 */
contract MockFinalizationTarget {
    error ClaimedMerkleLeaf();

    address public immutable multicall3;

    constructor(address _multicall3) {
        multicall3 = _multicall3;
    }

    // Mirrors a legacy OptimismPortal withdrawal, which keys its proof off msg.sender: only the address
    // that submitted the proof -- Multicall3, for a batch this bot submitted -- may finalize it.
    function finalizeWithdrawal() external view {
        require(msg.sender == multicall3, "proof not submitted by caller");
    }

    // A race lost to another finalizer, surfaced as a no-argument custom error.
    function alreadyClaimed() external pure {
        revert ClaimedMerkleLeaf();
    }

    // Any other failure: something an operator needs to look at.
    function notProven() external pure {
        revert("withdrawal not proven");
    }
}
