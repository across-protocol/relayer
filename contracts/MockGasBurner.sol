// SPDX-License-Identifier: AGPL-3.0-only
pragma solidity ^0.8.0;

// Burns a caller-specified, deterministic amount of gas and succeeds.
contract MockGasBurner {
    bytes32 public sink;
    bool public used;

    function burn(uint256 rounds) external {
        bytes32 h = sink;
        for (uint256 i = 0; i < rounds; i++) {
            h = keccak256(abi.encodePacked(h, i));
        }
        sink = h;
    }

    // Reverts unless the caller left at least `minGas`, while consuming almost none of it. Models OP-stack
    // SafeCall.callWithMinGas, whose requirement is a value the withdrawal declared on L2 rather than a function of
    // what the call spends — so the requirement is invisible to an estimator that only observes consumption.
    function requireGas(uint256 minGas) external view {
        require(gasleft() >= minGas, "MockGasBurner: Not enough gas");
    }

    // Succeeds once and reverts on every later call within the same execution. Models a finalization that passes a
    // pre-flight simulating each call alone, yet reverts in a batch that already contains it.
    function once() external {
        require(!used, "MockGasBurner: already used");
        used = true;
    }
}
