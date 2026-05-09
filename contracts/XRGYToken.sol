// SPDX-License-Identifier: MIT
// WARNING: MVP testnet implementation. Production deployment requires security audit by OpenZeppelin or Trail of Bits.
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Permit, IERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IXRGYToken} from "./interfaces/IXRGYToken.sol";

/**
 * @title XRGYToken
 * @author Exergy Protocol
 * @notice ERC-20 + EIP-2612 token for the Exergy Protocol.
 *
 * Design (read CORE_THESIS.md):
 *  - $XRGY is a *receipt for verified physical energy storage*. It is NEVER
 *    sold by the protocol or the company. The only way new tokens enter
 *    circulation is via the MintingEngine, which is gated by Proof-of-Charge
 *    (dual-signed measurement → OracleRouter → MintingEngine.mint).
 *  - There is NO burn. Energy consumption transfers tokens to the energy
 *    provider; the float self-regulates via MintingEngine.totalVerifiedEnergyInStorage.
 *
 * Architecture:
 *  - This contract is INTENTIONALLY immutable (no proxy). The token is the
 *    monetary primitive — upgradability would defeat the trust story.
 *  - The MintingEngine address is set ONCE post-deployment by the deployer
 *    (owner). After that, `mint` is permanently gated to that single address.
 *  - Owner has no minting power; owner only exists to wire the engine
 *    once and then renounces (recommended).
 *
 *  Decimals: 18 (default). 1 token = 1e18 wei.
 */
contract XRGYToken is ERC20, ERC20Permit, Ownable, IXRGYToken {
    /// @inheritdoc IXRGYToken
    address public override mintingEngine;

    /**
     * @param name_ ERC-20 name (e.g. "Exergy").
     * @param symbol_ ERC-20 symbol (e.g. "XRGY").
     * @param initialOwner Deployer / owner that will wire the MintingEngine and then renounce.
     */
    constructor(
        string memory name_,
        string memory symbol_,
        address initialOwner
    ) ERC20(name_, symbol_) ERC20Permit(name_) Ownable(initialOwner) {
        if (initialOwner == address(0)) revert ZeroAddress();
    }

    /**
     * @inheritdoc IXRGYToken
     * @dev One-shot setter. After this call, `mint` is permanently gated to `mintingEngine_`.
     *      Owner is expected to renounce ownership immediately afterwards.
     */
    function setMintingEngine(address mintingEngine_) external override onlyOwner {
        if (mintingEngine_ == address(0)) revert ZeroAddress();
        if (mintingEngine != address(0)) revert MintingEngineAlreadySet();
        mintingEngine = mintingEngine_;
        emit MintingEngineSet(mintingEngine_);
    }

    /**
     * @inheritdoc IXRGYToken
     * @dev Only the wired MintingEngine may mint. `to` MUST be non-zero (handled by ERC20._mint).
     */
    function mint(address to, uint256 amount) external override {
        if (msg.sender != mintingEngine) revert NotMintingEngine();
        _mint(to, amount);
    }

    /**
     * @dev OZ 5.x requires explicit override for `nonces` because it is declared in both
     *      ERC20Permit (via Nonces) and IERC20Permit. Routes to ERC20Permit's implementation.
     */
    function nonces(address owner)
        public
        view
        override(ERC20Permit, IERC20Permit)
        returns (uint256)
    {
        return super.nonces(owner);
    }
}
