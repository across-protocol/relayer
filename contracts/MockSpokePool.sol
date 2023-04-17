//SPDX-License-Identifier: Unlicense
pragma solidity ^0.8.0;

import "@across-protocol/contracts-v2/contracts/test/MockSpokePool.sol";

/**
 * @title MockSpokePool
 * @notice Implements abstract contract for testing.
 */
contract _MockSpokePool is SpokePool {
    uint256 private chainId_;
    uint256 private currentTime;

    function initialize(
        uint32 _initialDepositId,
        address _crossDomainAdmin,
        address _hubPool,
        address _wethAddress
    ) public initializer {
        __SpokePool_init(_initialDepositId, _crossDomainAdmin, _hubPool, _wethAddress);
        currentTime = block.timestamp; // solhint-disable-line not-rely-on-time
    }

    function setCurrentTime(uint256 time) external {
        currentTime = time;
    }

    function getCurrentTime() public view override returns (uint256) {
        return currentTime;
    }

    // solhint-disable-next-line no-empty-blocks
    function _bridgeTokensToHubPool(RelayerRefundLeaf memory relayerRefundLeaf) internal override {}

    function _requireAdminSender() internal override {} // solhint-disable-line no-empty-blocks

    function chainId() public view override(SpokePool) returns (uint256) {
        // If chainId_ is set then return it, else do nothing and return the parent chainId().
        return chainId_ == 0 ? super.chainId() : chainId_;
    }

    function setChainId(uint256 _chainId) public {
        chainId_ = _chainId;
    }

}
