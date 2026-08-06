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

    // Reverts unless the caller left at least `minGas`, while consuming almost none of it. Models OP-stack
    // SafeCall.callWithMinGas, whose requirement is a value the withdrawal declared on L2 rather than a function of
    // what the call spends, and so is invisible to an estimator that only observes consumption.
    function requireGas(uint256 minGas) external view {
        require(gasleft() >= minGas, "MockGasBurner: Not enough gas");
    }

    // Always reverts. Models a finalization that stopped being valid after the pre-flight simulated it.
    function fail() external pure {
        revert("MockGasBurner: failed");
    }

    // Consumes `rounds` worth of gas and only then reverts, so the gas is spent rather than returned to the caller.
    // Models the case that makes an unestimated call unsafe to put in a sized batch: eth_estimateGas can't size it,
    // but it still takes real gas out of whatever budget the batch was given.
    function burnThenFail(uint256 rounds) external {
        bytes32 h = sink;
        for (uint256 i = 0; i < rounds; i++) {
            h = keccak256(abi.encodePacked(h, i));
        }
        sink = h;
        revert("MockGasBurner: burned then failed");
    }
}
