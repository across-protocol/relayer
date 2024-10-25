// SPDX-License-Identifier: GPL-3.0-only
pragma solidity ^0.8.0;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@uma/core/contracts/common/implementation/MultiCaller.sol";
import "@uma/core/contracts/common/implementation/Lockable.sol";

interface Weth {
    function withdraw(uint256 _wad) external;

    function transferFrom(address _from, address _to, uint256 _wad) external;
}

/**
 * @notice Contract deployed on Ethereum helps relay bots atomically unwrap and bridge WETH over the canonical chain
 * bridges for chains that only support bridging of ETH not WETH.
 * @dev This contract is ownable so that the owner can update whitelisted bridge addresses and function selectors.
 */
contract AtomicWethDepositor is Ownable, MultiCaller, Lockable {
    // The Bridge used to send ETH to another chain. Only the function selector can be used when
    // calling the bridge contract.
    struct Bridge {
        address bridge;
        bytes4 funcSelector;
    }

    Weth public immutable WETH = Weth(0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2);

    /**
     * @notice Mapping of chain ID to whitelisted bridge addresses and function selectors
     * that can be called by this contract.
     */
    mapping(uint256 => Bridge) public whitelistedBridgeFunctions;

    ///////////////////////////////
    //          Events           //
    ///////////////////////////////

    event AtomicWethDepositInitiated(address indexed from, uint256 indexed chainId, uint256 amount);

    ///////////////////////////////
    //          Errors           //
    ///////////////////////////////

    error InvalidBridgeFunction();

    ///////////////////////////////
    //     Internal Functions    //
    ///////////////////////////////

    /**
     * @notice Transfers WETH to this contract and withdraws it to ETH.
     * @param amount The amount of WETH to withdraw.
     */
    function _withdrawWeth(uint256 amount) internal {
        WETH.transferFrom(msg.sender, address(this), amount);
        WETH.withdraw(amount);
    }

    ///////////////////////////////
    //     Admin Functions       //
    ///////////////////////////////

    /**
     * @notice Whitelists function selector and bridge contract for chain.
     * @param chainId The chain ID of the bridge.
     * @param bridge The address of the bridge contract to call to bridge ETH to the chain.
     * @param funcSelector The function selector of the bridge contract.
     */
    function whitelistBridge(uint256 chainId, address bridge, bytes4 funcSelector) public onlyOwner {
        whitelistedBridgeFunctions[chainId] = Bridge({ bridge: bridge, funcSelector: funcSelector });
    }

    ///////////////////////////////
    //     Public Functions      //
    ///////////////////////////////

    /**
     * @notice Initiates a WETH deposit to a whitelisted bridge for a specified chain with user calldata.
     * @dev Requires that the owner of this contract has whitelisted the bridge contract and function
     * selector for the chainId that the user wants to send ETH to.
     * @param value The amount of WETH to deposit.
     * @param chainId The chain to send ETH to.
     * @param bridgeCallData The calldata to pass to the bridge contract. The first 4 bytes should be equal
     * to the whitelisted function selector of the bridge contract.
     */
    function bridgeWeth(uint256 chainId, uint256 value, bytes calldata bridgeCallData) public nonReentrant {
        _withdrawWeth(value);
        Bridge memory bridge = whitelistedBridgeFunctions[chainId];
        if (bridge.funcSelector != bytes4(bridgeCallData)) revert InvalidBridgeFunction();
        // solhint-disable-next-line avoid-low-level-calls
        (bool success, bytes memory result) = bridge.bridge.call{ value: value }(bridgeCallData);
        require(success, string(result));
        emit AtomicWethDepositInitiated(msg.sender, chainId, value);
    }

    fallback() external payable {}

    // Included to remove a compilation warning.
    // NOTE: this should not affect behavior.
    receive() external payable {}
}
