// SPDX-License-Identifier: AGPL-3.0-only
pragma solidity ^0.8.0;

// Burns a caller-specified, deterministic amount of gas and succeeds.
contract MockGasBurner {
    bytes32 public sink;

    function burn(uint256 rounds) external {
        _burn(rounds);
    }

    // As burn(), but spends the gas `depth` frames further down: recurses through external self-calls and burns in
    // the deepest frame only, so the gas lands depth + 1 frames below the caller. Models a proxied finalization
    // target, whose gas lands well below the batch's own frame.
    function burnNested(uint256 depth, uint256 rounds) external {
        if (depth == 0) {
            _burn(rounds);
            return;
        }
        // Bubble a deep failure up, so an inner frame running out of gas surfaces as this call failing rather
        // than being swallowed mid-tree.
        (bool success, ) = address(this).call(
            abi.encodeWithSelector(this.burnNested.selector, depth - 1, rounds)
        );
        require(success, "nested burn failed");
    }

    function _burn(uint256 rounds) internal {
        bytes32 h = sink;
        for (uint256 i = 0; i < rounds; i++) {
            h = keccak256(abi.encodePacked(h, i));
        }
        sink = h;
    }
}
