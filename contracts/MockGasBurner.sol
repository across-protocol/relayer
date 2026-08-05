// SPDX-License-Identifier: AGPL-3.0-only
pragma solidity ^0.8.0;

// Burns a caller-specified, deterministic amount of gas and succeeds.
contract MockGasBurner {
    bytes32 public sink;

    function burn(uint256 rounds) external {
        bytes32 h = sink;
        for (uint256 i = 0; i < rounds; i++) {
            h = keccak256(abi.encodePacked(h, i));
        }
        sink = h;
    }
}
