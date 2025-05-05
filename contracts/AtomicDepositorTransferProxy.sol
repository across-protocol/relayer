// SPDX-License-Identifier: GPL-3.0-only
pragma solidity ^0.8.0;

/**
 * @notice Contract deployed on Ethereum which is meant to be a whitelisted bridge on the AtomicWethDepositor for all networks which
 * rebalance WETH via a centralized exchange that uses (non-static) EOA deposit addresses.
 */
contract AtomicDepositorTransferProxy {
    /**
     * @notice Transfers `msg.value` to the input `to` address.
     * @param to The address to receive `msg.value`.
     */
    function transfer(address to) external payable {
        (bool success, ) = to.call{ value: msg.value }("");
        require(success, "ETH transfer failed.");
    }
}
