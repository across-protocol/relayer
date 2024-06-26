// SPDX-License-Identifier: GPL-3.0-only
pragma solidity ^0.8.0;

import "@openzeppelin/contracts/access/Ownable.sol";

///////////////////////////////
//   Interfaces for Bridges  //
///////////////////////////////

interface Weth {
    function withdraw(uint256 _wad) external;

    function transferFrom(address _from, address _to, uint256 _wad) external;
}

interface OvmL1Bridge {
    function depositETHTo(address _to, uint32 _l2Gas, bytes calldata _data) external payable;
}

interface PolygonL1Bridge {
    function depositEtherFor(address _to) external payable;
}

interface ZkSyncL1Bridge {
    function requestL2Transaction(
        address _contractL2,
        uint256 _l2Value,
        bytes calldata _calldata,
        uint256 _l2GasLimit,
        uint256 _l2GasPerPubdataByteLimit,
        bytes[] calldata _factoryDeps,
        address _refundRecipient
    ) external payable;

    function l2TransactionBaseCost(
        uint256 _gasPrice,
        uint256 _l2GasLimit,
        uint256 _l2GasPerPubdataByteLimit
    ) external pure returns (uint256);
}

interface LineaL1MessageService {
    function sendMessage(address _to, uint256 _fee, bytes calldata _calldata) external payable;
}

/**
 * @notice Contract deployed on Ethereum helps relay bots atomically unwrap and bridge WETH over the canonical chain
 * bridges for Optimism, Base, Boba, ZkSync, Linea, and Polygon. Needed as these chains only support bridging of ETH,
 * not WETH.
 * @dev This contract is ownable so that the owner can update the OvmL1Bridge contracts for new chains.
 */
contract AtomicWethDepositor is Ownable {
    ///////////////////////////////
    //   Hardcoded Addresses     //
    ///////////////////////////////

    Weth public immutable weth = Weth(0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2);
    PolygonL1Bridge public immutable polygonL1Bridge = PolygonL1Bridge(0xA0c68C638235ee32657e8f720a23ceC1bFc77C77);
    ZkSyncL1Bridge public immutable zkSyncL1Bridge = ZkSyncL1Bridge(0x32400084C286CF3E17e7B677ea9583e60a000324);
    LineaL1MessageService public immutable lineaL1MessageService =
        LineaL1MessageService(0xd19d4B5d358258f05D7B411E21A1460D11B0876F);

    ///////////////////////////////
    //     Dynamic Variables     //
    ///////////////////////////////

    /**
     * @notice All OVM Chains have an OvmL1Bridge contract that can be called to deposit ETH.
     * @notice This mapping is a convenience to allow for easy lookup of the OvmL1Bridge contract for a given chainId.
     */
    mapping(uint256 => OvmL1Bridge) public ovmChainIdToBridge;

    ///////////////////////////////
    //          Events           //
    ///////////////////////////////

    event ZkSyncEthDepositInitiated(address indexed from, address indexed to, uint256 amount);
    event LineaEthDepositInitiated(address indexed from, address indexed to, uint256 amount);
    event OVMEthDepositInitiated(uint256 indexed chainId, address indexed from, address indexed to, uint256 amount);
    event PolygonEthDepositInitiated(address indexed from, address indexed to, uint256 amount);
    event OVML1BridgeModified(uint256 indexed chainId, address indexed newBridge, address oldBridge);

    ///////////////////////////////
    //          Errors           //
    ///////////////////////////////

    error InvalidOvmChainId();

    ///////////////////////////////
    //     Internal Functions    //
    ///////////////////////////////

    /**
     * @notice Transfers WETH to this contract and withdraws it to ETH.
     * @param amount The amount of WETH to withdraw.
     */
    function _withdrawWeth(uint256 amount) internal {
        weth.transferFrom(msg.sender, address(this), amount);
        weth.withdraw(amount);
    }

    ///////////////////////////////
    //     Admin Functions       //
    ///////////////////////////////

    /**
     * @notice Sets the OvmL1Bridge contract for a given chainId.
     * @dev Supplying a zero address will disable the bridge.
     * @param chainId The chainId of the OVM chain.
     * @param newBridge The address of the OvmL1Bridge contract for the given chainId.
     */
    function setOvmL1Bridge(uint256 chainId, OvmL1Bridge newBridge) public onlyOwner {
        OvmL1Bridge oldBridge = ovmChainIdToBridge[chainId];
        ovmChainIdToBridge[chainId] = newBridge;
        emit OVML1BridgeModified(chainId, address(newBridge), address(oldBridge));
    }

    ///////////////////////////////
    //     Public Functions      //
    ///////////////////////////////

    /**
     * @notice Initiates a WETH deposit to an OVM chain.
     * @param to The address on the OVM chain to receive the WETH.
     * @param amount The amount of WETH to deposit.
     * @param l2Gas The amount of gas to send with the deposit transaction.
     * @param chainId The chainId of the OVM chain to deposit to.
     * @dev throws InvalidOvmChainId if the chainId provided is not a valid OVM chainId.
     */
    function bridgeWethToOvm(address to, uint256 amount, uint32 l2Gas, uint256 chainId) public {
        OvmL1Bridge ovmL1Bridge = ovmChainIdToBridge[chainId];
        if (address(ovmL1Bridge) == address(0)) {
            revert InvalidOvmChainId();
        }
        _withdrawWeth(amount);
        ovmL1Bridge.depositETHTo{ value: amount }(to, l2Gas, "");
        emit OVMEthDepositInitiated(chainId, msg.sender, to, amount);
    }

    /**
     * @notice Initiates a WETH deposit to Polygon.
     * @param to The address on Polygon to receive the WETH.
     * @param amount The amount of WETH to deposit.
     */
    function bridgeWethToPolygon(address to, uint256 amount) public {
        _withdrawWeth(amount);
        polygonL1Bridge.depositEtherFor{ value: amount }(to);
        emit PolygonEthDepositInitiated(msg.sender, to, amount);
    }

    /**
     * @notice Initiates a WETH deposit to Linea.
     * @param to The address on Linea to receive the WETH.
     * @param amount The amount of WETH to deposit.
     */
    function bridgeWethToLinea(address to, uint256 amount) public payable {
        _withdrawWeth(amount);
        lineaL1MessageService.sendMessage{ value: amount + msg.value }(to, msg.value, "");
        emit LineaEthDepositInitiated(msg.sender, to, amount);
    }

    /**
     * @notice Initiates a WETH deposit to ZkSync.
     * @param to The address on ZkSync to receive the WETH.
     * @param amount The amount of WETH to deposit.
     * @param l2GasLimit The amount of gas to send with the deposit transaction.
     * @param l2GasPerPubdataByteLimit The amount of gas per pubdata byte to send with the deposit transaction.
     * @param refundRecipient The address to refund any excess gas to.
     */
    function bridgeWethToZkSync(
        address to,
        uint256 amount,
        uint256 l2GasLimit,
        uint256 l2GasPerPubdataByteLimit,
        address refundRecipient
    ) public {
        // The ZkSync Mailbox contract checks that the msg.value of the transaction is enough to cover the transaction base
        // cost. The transaction base cost can be queried from the Mailbox by passing in an L1 "executed" gas price,
        // which is the priority fee plus base fee. This is the same as calling tx.gasprice on-chain as the Mailbox
        // contract does here:
        // https://github.com/matter-labs/era-contracts/blob/3a4506522aaef81485d8abb96f5a6394bd2ba69e/ethereum/contracts/zksync/facets/Mailbox.sol#L287
        uint256 l2TransactionBaseCost = zkSyncL1Bridge.l2TransactionBaseCost(
            tx.gasprice,
            l2GasLimit,
            l2GasPerPubdataByteLimit
        );
        uint256 valueToSubmitXChainMessage = l2TransactionBaseCost + amount;
        _withdrawWeth(valueToSubmitXChainMessage);
        zkSyncL1Bridge.requestL2Transaction{ value: valueToSubmitXChainMessage }(
            to,
            amount,
            "",
            l2GasLimit,
            l2GasPerPubdataByteLimit,
            new bytes[](0),
            refundRecipient
        );
        emit ZkSyncEthDepositInitiated(msg.sender, to, amount);
    }

    ///////////////////////////////
    //          Fallback         //
    ///////////////////////////////

    fallback() external payable {}

    // Included to remove a compilation warning.
    // NOTE: this should not affect behavior.
    receive() external payable {}
}
