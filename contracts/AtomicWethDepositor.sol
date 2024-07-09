// SPDX-License-Identifier: GPL-3.0-only
pragma solidity ^0.8.0;

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
 */

contract AtomicWethDepositor {
    Weth public immutable weth = Weth(0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2);
    OvmL1Bridge public immutable optimismL1Bridge = OvmL1Bridge(0x99C9fc46f92E8a1c0deC1b1747d010903E884bE1);
    OvmL1Bridge public immutable modeL1Bridge = OvmL1Bridge(0x735aDBbE72226BD52e818E7181953f42E3b0FF21);
    OvmL1Bridge public immutable bobaL1Bridge = OvmL1Bridge(0xdc1664458d2f0B6090bEa60A8793A4E66c2F1c00);
    OvmL1Bridge public immutable baseL1Bridge = OvmL1Bridge(0x3154Cf16ccdb4C6d922629664174b904d80F2C35);
    OvmL1Bridge public immutable liskL1Bridge = OvmL1Bridge(0x2658723Bf70c7667De6B25F99fcce13A16D25d08);
    PolygonL1Bridge public immutable polygonL1Bridge = PolygonL1Bridge(0xA0c68C638235ee32657e8f720a23ceC1bFc77C77);
    ZkSyncL1Bridge public immutable zkSyncL1Bridge = ZkSyncL1Bridge(0x32400084C286CF3E17e7B677ea9583e60a000324);
    LineaL1MessageService public immutable lineaL1MessageService =
        LineaL1MessageService(0xd19d4B5d358258f05D7B411E21A1460D11B0876F);

    event ZkSyncEthDepositInitiated(address indexed from, address indexed to, uint256 amount);
    event LineaEthDepositInitiated(address indexed from, address indexed to, uint256 amount);
    event OvmEthDepositInitiated(uint256 indexed chainId, address indexed from, address indexed to, uint256 amount);

    function bridgeWethToOvm(address to, uint256 amount, uint32 l2Gas, uint256 chainId) public {
        weth.transferFrom(msg.sender, address(this), amount);
        weth.withdraw(amount);

        if (chainId == 10) {
            optimismL1Bridge.depositETHTo{ value: amount }(to, l2Gas, "");
        } else if (chainId == 8453) {
            baseL1Bridge.depositETHTo{ value: amount }(to, l2Gas, "");
        } else if (chainId == 34443) {
            modeL1Bridge.depositETHTo{ value: amount }(to, l2Gas, "");
        } else if (chainId == 1135) {
            liskL1Bridge.depositETHTo{ value: amount }(to, l2Gas, "");
        } else if (chainId == 288) {
            bobaL1Bridge.depositETHTo{ value: amount }(to, l2Gas, "");
        } else {
            revert("Invalid OVM chainId");
        }

        emit OvmEthDepositInitiated(chainId, msg.sender, to, amount);
    }

    function bridgeWethToPolygon(address to, uint256 amount) public {
        weth.transferFrom(msg.sender, address(this), amount);
        weth.withdraw(amount);
        polygonL1Bridge.depositEtherFor{ value: amount }(to);
    }

    function bridgeWethToLinea(address to, uint256 amount) public payable {
        weth.transferFrom(msg.sender, address(this), amount);
        weth.withdraw(amount);
        lineaL1MessageService.sendMessage{ value: amount + msg.value }(to, msg.value, "");
        // Emit an event that we can easily track in the Linea-related adapters/finalizers
        emit LineaEthDepositInitiated(msg.sender, to, amount);
    }

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
        weth.transferFrom(msg.sender, address(this), valueToSubmitXChainMessage);
        weth.withdraw(valueToSubmitXChainMessage);
        zkSyncL1Bridge.requestL2Transaction{ value: valueToSubmitXChainMessage }(
            to,
            amount,
            "",
            l2GasLimit,
            l2GasPerPubdataByteLimit,
            new bytes[](0),
            refundRecipient
        );

        // Emit an event that we can easily track in the ZkSyncAdapter because otherwise there is no easy event to
        // track ETH deposit initiations.
        emit ZkSyncEthDepositInitiated(msg.sender, to, amount);
    }

    fallback() external payable {}

    // Included to remove a compilation warning.
    // NOTE: this should not affect behavior.
    receive() external payable {}
}
