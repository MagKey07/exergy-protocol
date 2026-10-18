// SPDX-License-Identifier: BUSL-1.1
// WARNING: MVP testnet implementation. Production deployment requires security audit by OpenZeppelin or Trail of Bits.
pragma solidity ^0.8.24;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/**
 * @title InsuranceReserve
 * @author Exergy Protocol
 * @notice The network's insurance reserve. Receives 1% of every mint
 *         (MintingEngine mints it here). Notes leave only to cover proven fraud
 *         or meter failure, by a release that names its reason on-chain.
 *
 * @dev The reserve belongs to the network, not to Key Energy. Today the
 *      RELEASER_ROLE is held by the admin; before mainnet it moves to the
 *      community governance contract (double majority, timelock), and the
 *      admin renounces it.
 */
contract InsuranceReserve is AccessControl {
    using SafeERC20 for IERC20;

    bytes32 public constant RELEASER_ROLE = keccak256("RELEASER_ROLE");

    IERC20 public immutable token;

    /// @notice Notes released from the reserve.
    event Released(address indexed to, uint256 amount, string reason);

    error ZeroAddress();
    error AmountZero();
    error ReasonRequired();

    constructor(address token_, address admin) {
        if (token_ == address(0) || admin == address(0)) revert ZeroAddress();
        token = IERC20(token_);
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(RELEASER_ROLE, admin);
    }

    /// @notice Release notes to cover a proven loss. The reason is recorded on-chain.
    function release(address to, uint256 amount, string calldata reason) external onlyRole(RELEASER_ROLE) {
        if (to == address(0)) revert ZeroAddress();
        if (amount == 0) revert AmountZero();
        if (bytes(reason).length == 0) revert ReasonRequired();
        token.safeTransfer(to, amount);
        emit Released(to, amount, reason);
    }

    /// @notice Notes currently held by the reserve.
    function balance() external view returns (uint256) {
        return token.balanceOf(address(this));
    }
}
