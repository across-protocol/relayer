//SPDX-License-Identifier: Unlicense
pragma solidity ^0.8.0;

/**
 * @title MockMulticallReceiver
 */
contract MockMulticallReceiver {
    struct Result {
        bool success;
        bytes returnData;
    }

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {} // solhint-disable-line no-empty-blocks

    // Entrypoint for tryMulticall tests. For simplicity, a call will succeed if its MSB is nonzero.
    function tryMulticall(bytes[] calldata calls) external pure returns (Result[] memory) {
        Result[] memory results = new Result[](calls.length);
        for (uint256 i = 0; i < calls.length; ++i) {
            bool success = uint256(bytes32(calls[i])) != 0;
            results[i] = Result(success, calls[i]);
        }
        return results;
    }

    // In the MultiCallerClient, we require the contract we are calling to contain
    // multicall in order for the transaction to not be marked as unsendable.
    // https://github.com/across-protocol/relayer/blob/e56a6874419eeded58d64e77a1628b6541861b65/src/clients/MultiCallerClient.ts#L374
    function multicall() external {}
}
