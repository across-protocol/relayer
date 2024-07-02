// This file contains contracts that can be used to unit test bridge adapters.

pragma solidity ^0.8.0;

contract MockHubPool {
    event TokensRelayed(address l1Token, address l2Token, uint256 amount, address to);

    function relayTokens(address l1Token, address l2Token, uint256 amount, address to) public {
        emit TokensRelayed(l1Token, l2Token, amount, to);
    }
}
