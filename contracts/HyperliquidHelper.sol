// SPDX-License-Identifier: GPL-3.0-only
pragma solidity ^0.8.0;

import "@openzeppelin/contracts-v4/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts-v4/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts-v4/security/ReentrancyGuard.sol";
import { HyperCoreLib } from "../libraries/HyperCoreLib.sol";
import { Ownable } from "@openzeppelin/contracts-v4/access/Ownable.sol";

/**
 * @notice Contract deployed on HyperEVM designed to help the deployer deposit and withdraw tokens to and from Hypercore,
 * and place orders atomically.
 */
contract HyperliquidHelper is ReentrancyGuard, Ownable {
    using SafeERC20 for IERC20;
    struct TokenInfo {
        // HyperEVM token address.
        address evmAddress;
        // Hypercore token index.
        uint64 tokenId;
        // Spot market index where this token is the final token.
        uint32 spotIndex;
         // To go baseToken -> finalToken, do we have to enqueue a buy or a sell?
        bool isBuy;
        // Activation fee in EVM units. e.g. 1000000 ($1) for USDH.
        uint256 activationFeeEvm;
        // coreDecimals - evmDecimals. e.g. -2 for USDH.
        int8 decimalDiff;
    }

    // Stores hardcoded Hypercore configurations for tokens that this handler supports.
    mapping(address => TokenInfo) public supportedTokens;

    uint8 private constant IOC_ORDER_TYPE = 3; // immediate or cancel order type executes immediately or is cancelled

    error TokenNotSupported();

    event UserAccountActivated(address user, address indexed token, uint256 amountRequiredToActivate);
    event AddedSupportedToken(address evmAddress, uint64 tokenId, uint256 activationFeeEvm, int8 decimalDiff);

    constructor() {
        // Maybe pull 1 USDC from deployer and activate this account on Hypercore if possible.
    }
    /// -------------------------------------------------------------------------------------------------------------
    /// - ONLY OWNER FUNCTIONS -
    /// -------------------------------------------------------------------------------------------------------------

    function depositToHypercore(
        address inToken,
        address outToken,
        uint256 amount,
        uint64 limitPriceX1e8,
        uint128 cloid
    ) external nonReentrant onlyOwner {
        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);
        uint64 amountCoreToReceive = _depositToHypercore(token, amount);
        _placeOrder(token, limitPriceX1e8, amountCoreToReceive, cloid);
    }

    function withdrawToHyperevm(
        address token,
        uint64 coreAmount,
        address user
    ) external nonReentrant onlyOwner {
        _withdrawToHyperevm(token, coreAmount, user);
    }

    function bridgeToEvm(
        address token,
        uint256 amount,
        uint256 destinationChain
    ) external nonReentrant onlyOwner {
        _bridgeToEvm(token, amount, destinationChain);
    }

    /**
     * @notice Adds a new token to the supported tokens list.
     * @dev Caller must be owner of this contract.
     * @param evmAddress The address of the EVM token.
     * @param tokenId The index of the Hypercore token.
     * @param activationFeeEvm The activation fee in EVM units.
     * @param decimalDiff The difference in decimals between the EVM and Hypercore tokens.
     */
    function addSupportedToken(
        address evmAddress,
        uint64 tokenId,
        uint256 activationFeeEvm,
        int8 decimalDiff
    ) external onlyOwner {
        supportedTokens[evmAddress] = TokenInfo({
            evmAddress: evmAddress,
            tokenId: tokenId,
            activationFeeEvm: activationFeeEvm,
            decimalDiff: decimalDiff
        });
        emit AddedSupportedToken(evmAddress, tokenId, activationFeeEvm, decimalDiff);
    }

    /**
     * @notice Send Hypercore funds to a user from this contract's Hypercore account
     * @dev The coreAmount parameter is specified in Hypercore units which often differs from the EVM units for the
     * same token.
     * @param token The token address
     * @param coreAmount The amount of tokens on Hypercore to sweep
     * @param user The address of the user to send the tokens to
     */
    function sweepCoreFundsToUser(address token, uint64 coreAmount, address user) external onlyOwner nonReentrant {
        uint64 tokenIndex = _getTokenInfo(token).tokenId;
        HyperCoreLib.transferERC20CoreToCore(tokenIndex, user, coreAmount);
    }

    /**
     * @notice Send ERC20 tokens to a user from this contract's address on HyperEVM
     * @param token The token address
     * @param evmAmount The amount of tokens to sweep
     * @param user The address of the user to send the tokens to
     */
    function sweepERC20ToUser(address token, uint256 evmAmount, address user) external onlyOwner nonReentrant {
        IERC20(token).safeTransfer(user, evmAmount);
    }

    /// -------------------------------------------------------------------------------------------------------------
    /// - INTERNAL FUNCTIONS -
    /// -------------------------------------------------------------------------------------------------------------

    function _depositToHypercore(address token, uint256 evmAmount) internal returns (uint64 amountCoreToReceive) {
        TokenInfo memory tokenInfo = _getTokenInfo(token);
        uint64 tokenIndex = tokenInfo.tokenId;
        int8 decimalDiff = tokenInfo.decimalDiff;

        // We assume this account is already activated.

        (, amountCoreToReceive) = HyperCoreLib.transferERC20EVMToCore(token, tokenIndex, address(this), evmAmount, decimalDiff);
    }

    function _placeOrder(
        address token,
        uint64 limitPriceX1e8,
        uint64 sizeX1e8,
        uint128 cloid
    ) internal {
        TokenInfo memory tokenInfo = _getTokenInfo(token);
        uint32 asset = tokenInfo.spotIndex;
        bool isBuy = tokenInfo.isBuy;

        HyperCoreLib.submitLimitOrder(asset, isBuy, limitPriceX1e8, sizeX1e8, false /* reduceOnly */, IOC_ORDER_TYPE, cloid);
    }

    function _withdrawToHyperevm(address token, uint64 coreAmount, address user) internal {
        TokenInfo memory tokenInfo = _getTokenInfo(token);
        uint64 tokenIndex = tokenInfo.tokenId;
        // To withdraw to EVM, spot send tokens to the HyperEVM token address on Core.
        HyperCoreLib.transferERC20CoreToCore(tokenIndex, token, coreAmount);
    }

    function _bridgeToEvm(address token, uint256 amount, uint256 destinationChain) internal {
        // TODO:
        // If USDC, use CCTP
        // If USDT, use OFT
        // Else, revert.
    }

    function _getTokenInfo(address evmAddress) internal view returns (TokenInfo memory) {
        if (supportedTokens[evmAddress].evmAddress == address(0)) {
            revert TokenNotSupported();
        }
        return supportedTokens[evmAddress];
    }

    // Native tokens are not supported by this contract, so there is no fallback function.
}
