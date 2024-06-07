//SPDX-License-Identifier: Unlicense
pragma solidity ^0.8.0;

import "@across-protocol/contracts/contracts/test/MockSpokePool.sol";

/**
 * @title MockSpokePool
 * @dev For some reason, the @openzeppelin/hardhat-upgrades plugin fails to find the MockSpokePool ABI unless
 * this contract is explicitly defined here.
 */
contract _MockSpokePool is MockSpokePool {
    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor(address _wrappedNativeTokenAddress) MockSpokePool(_wrappedNativeTokenAddress) {} // solhint-disable-line no-empty-blocks
}
