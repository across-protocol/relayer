//SPDX-License-Identifier: AGPL-3.0-only
pragma solidity ^0.8.0;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/token/ERC1155/IERC1155.sol";

/**
 * @notice Across custom handler that swaps bridged USDC.e to the solver in exchange for ERC1155 outcome tokens.
 */
contract PolymarketHandler is Ownable {
    using SafeERC20 for IERC20;

    error NotSpokePool();
    error TokenNotAllowed();
    error RelayerNotAllowed();
    error RelayerMismatch();
    error InvalidMessageVersion();
    error ZeroAddress();

    event SolverAllowed(address indexed solver, bool allowed);
    event PolymarketFill(
        address indexed relayer,
        address indexed solver,
        address indexed recipient,
        address outcomeToken,
        uint256 tokenId,
        uint256 outcomeAmount,
        address paymentToken,
        uint256 paymentAmount,
        bytes32 clientOrderId
    );

    struct PolyOrderIntentV1 {
        uint8 version;
        address recipient;
        address solver;
        address outcomeToken;
        uint256 tokenId;
        uint256 outcomeAmount;
        uint256 limitPrice;
        bytes32 clientOrderId;
    }

    address public immutable spokePool;
    address public immutable paymentToken;

    mapping(address => bool) public allowedSolvers;

    constructor(address _spokePool, address _paymentToken, address _owner) Ownable(_owner) {
        if (_spokePool == address(0) || _paymentToken == address(0) || _owner == address(0)) {
            revert ZeroAddress();
        }
        spokePool = _spokePool;
        paymentToken = _paymentToken;
    }

    function setSolverAllowed(address solver, bool allowed) external onlyOwner {
        allowedSolvers[solver] = allowed;
        emit SolverAllowed(solver, allowed);
    }

    function handleV3AcrossMessage(
        address tokenSent,
        uint256 amount,
        address relayer,
        bytes calldata message
    ) external {
        if (msg.sender != spokePool) revert NotSpokePool();
        if (tokenSent != paymentToken) revert TokenNotAllowed();
        if (!allowedSolvers[relayer]) revert RelayerNotAllowed();

        PolyOrderIntentV1 memory intent = abi.decode(message, (PolyOrderIntentV1));
        if (intent.version != 1) revert InvalidMessageVersion();
        if (intent.solver != relayer) revert RelayerMismatch();
        if (intent.recipient == address(0) || intent.outcomeToken == address(0)) revert ZeroAddress();

        // Transfer outcome tokens from solver to user.
        IERC1155(intent.outcomeToken).safeTransferFrom(
            intent.solver,
            intent.recipient,
            intent.tokenId,
            intent.outcomeAmount,
            ""
        );

        // Pay solver with bridged USDC.e.
        IERC20(paymentToken).safeTransfer(relayer, amount);

        emit PolymarketFill(
            relayer,
            intent.solver,
            intent.recipient,
            intent.outcomeToken,
            intent.tokenId,
            intent.outcomeAmount,
            paymentToken,
            amount,
            intent.clientOrderId
        );
    }
}
