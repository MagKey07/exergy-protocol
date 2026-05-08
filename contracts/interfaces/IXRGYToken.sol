// SPDX-License-Identifier: MIT
// WARNING: MVP testnet implementation. Production deployment requires security audit by OpenZeppelin or Trail of Bits.
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Permit.sol";

/**
 * @title IXRGYToken
 * @notice Interface for the $XRGY ERC-20 token.
 *
 * Design notes (read CORE_THESIS.md before changing):
 *  - $XRGY is a *receipt* for verified physical energy storage (Proof-of-Charge).
 *  - Tokens are minted ONLY by the MintingEngine, never sold, never pre-mined.
 *  - There is NO burn function. When energy is consumed, the token transfers
 *    to the energy provider. It continues circulating like money. Floating index
 *    self-regulates as totalVerifiedEnergyInStorage moves with physical reality.
 *
 * @dev Inherits IERC20 + IERC20Permit (EIP-2612 gasless approvals).
 */
interface IXRGYToken is IERC20, IERC20Permit {
    /// @notice Emitted when the MintingEngine address is set (one-time).
    event MintingEngineSet(address indexed mintingEngine);

    /// @notice Caller is not the authorized MintingEngine.
    error NotMintingEngine();
    /// @notice MintingEngine address has already been set; cannot rebind.
    error MintingEngineAlreadySet();
    /// @notice Provided address is the zero address.
    error ZeroAddress();

    /**
     * @notice Mint new $XRGY to a recipient. Restricted to the MintingEngine.
     * @param to Recipient of the freshly minted tokens.
     * @param amount Amount of tokens (18 decimals).
     */
    function mint(address to, uint256 amount) external;

    /**
     * @notice One-time wiring of the MintingEngine address.
     * @param mintingEngine Address of the deployed MintingEngine proxy.
     */
    function setMintingEngine(address mintingEngine) external;

    /// @notice Returns the address authorized to mint $XRGY.
    function mintingEngine() external view returns (address);
}
