//SPDX-License-Identifier: Unlicense
pragma solidity ^0.8.0;

import "@across-protocol/contracts-v2/contracts/test/MockSpokePool.sol";

/**
 * @title MockSpokePool
 * @dev For some reason, the @openzeppelin/hardhat-upgrades plugin fails to find the MockSpokePool ABI unless
 * this contract is explicitly defined here.
 */
contract _MockSpokePool is MockSpokePool {

}
