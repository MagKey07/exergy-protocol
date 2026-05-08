// SPDX-License-Identifier: MIT
// WARNING: MVP testnet implementation. Production deployment requires security audit by OpenZeppelin or Trail of Bits.
pragma solidity ^0.8.24;

import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {AccessControlUpgradeable} from "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import {PausableUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";
import {ReentrancyGuardUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {ISettlement} from "./interfaces/ISettlement.sol";
import {IMintingEngine} from "./interfaces/IMintingEngine.sol";

/**
 * @title Settlement
 * @author Exergy Protocol
 * @notice Token transfer + fee routing.
 *
 * @dev CRITICAL: NO BURN. Every settlement is a token *transfer* to the
 * energy provider, never destruction. The float self-regulates via
 * MintingEngine.totalVerifiedEnergyInStorage.
 *
 * Fee semantics (testnet defaults):
 *  - Settlement fee: 0.25% (25 bps) of each settle, paid by payer ON TOP of
 *    the principal. So `settleEnergy(provider, A, k)` requires the payer to
 *    have approved `A + A*0.25%` to Settlement.
 *  - Minting fee: 1.0% (100 bps) of newly-minted tokens, pulled from the
 *    fresh mint via MintingEngine's post-mint hook. The VPP recipient must
 *    have a standing approval to Settlement to allow the pull. If approval
 *    is missing on testnet, the pull silently no-ops (engine swallows revert)
 *    — production should harden this.
 *  - Distribution: Treasury 40 / Team 20 / Ecosystem 25 / Insurance 15 (bps over 10_000).
 */
contract Settlement is
    ISettlement,
    Initializable,
    UUPSUpgradeable,
    AccessControlUpgradeable,
    PausableUpgradeable,
    ReentrancyGuardUpgradeable
{
    using SafeERC20 for IERC20;

    // ---------------------------------------------------------------------
    // Roles & constants
    // ---------------------------------------------------------------------

    bytes32 public constant UPGRADER_ROLE = keccak256("UPGRADER_ROLE");
    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");
    bytes32 public constant FEE_MANAGER_ROLE = keccak256("FEE_MANAGER_ROLE");

    /// @notice Hard ceiling on any fee bps to defang misconfigured fees.
    uint256 public constant MAX_FEE_BPS = 1_000; // 10%
    uint256 public constant BPS_DENOMINATOR = 10_000;

    // Distribution shares (bps over 10_000 of the *fee*, not of the principal):
    uint256 public constant TREASURY_SHARE_BPS = 4_000;
    uint256 public constant TEAM_SHARE_BPS = 2_000;
    uint256 public constant ECOSYSTEM_SHARE_BPS = 2_500;
    uint256 public constant INSURANCE_SHARE_BPS = 1_500;
    // (Sums to 10_000 = 100% of fee.)

    // ---------------------------------------------------------------------
    // Storage
    // ---------------------------------------------------------------------

    IERC20 public token;
    IMintingEngine public mintingEngine;

    uint256 public override settlementFeeBps; // default 25 (=0.25%)
    uint256 public override mintingFeeBps; // default 100 (=1.00%)

    FeeRecipients private _recipients;

    /// @dev Reserved storage gap for upgradeable layout safety.
    uint256[40] private __gap;

    // ---------------------------------------------------------------------
    // Initializer
    // ---------------------------------------------------------------------

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(
        address admin,
        address token_,
        address mintingEngine_,
        FeeRecipients calldata recipients_
    ) external initializer {
        if (admin == address(0) || token_ == address(0) || mintingEngine_ == address(0)) revert ZeroAddress();
        if (
            recipients_.treasury == address(0) ||
            recipients_.team == address(0) ||
            recipients_.ecosystem == address(0) ||
            recipients_.insurance == address(0)
        ) revert ZeroAddress();

        __UUPSUpgradeable_init();
        __AccessControl_init();
        __Pausable_init();
        __ReentrancyGuard_init();

        token = IERC20(token_);
        mintingEngine = IMintingEngine(mintingEngine_);
        _recipients = recipients_;
        settlementFeeBps = 25; // 0.25%
        mintingFeeBps = 100; // 1.00%

        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(UPGRADER_ROLE, admin);
        _grantRole(PAUSER_ROLE, admin);
        _grantRole(FEE_MANAGER_ROLE, admin);

        emit FeeRecipientsUpdated(recipients_);
        emit SettlementFeeBpsUpdated(25);
        emit MintingFeeBpsUpdated(100);
    }

    // ---------------------------------------------------------------------
    // Settle flows — NO BURN
    // ---------------------------------------------------------------------

    /// @inheritdoc ISettlement
    function settleEnergy(
        address provider,
        uint256 tokenAmount,
        uint256 kwhConsumed
    ) external override whenNotPaused nonReentrant {
        if (provider == address(0)) revert ZeroAddress();
        if (tokenAmount == 0) revert AmountZero();

        uint256 fee = (tokenAmount * settlementFeeBps) / BPS_DENOMINATOR;

        // Pull principal → provider. (NO burn; this is a transfer.)
        token.safeTransferFrom(msg.sender, provider, tokenAmount);

        // Pull fee → this contract, then distribute.
        if (fee > 0) {
            token.safeTransferFrom(msg.sender, address(this), fee);
            _distributeFees(fee);
        }

        // Tell engine the storage just shrank.
        if (kwhConsumed > 0) {
            mintingEngine.recordEnergyConsumption(kwhConsumed);
        }

        emit EnergySettled(msg.sender, provider, tokenAmount, kwhConsumed, fee);
    }

    /// @inheritdoc ISettlement
    function crossVPPSettle(
        address receiver,
        bytes32 counterpartyVPPId,
        uint256 tokenAmount
    ) external override whenNotPaused nonReentrant {
        if (receiver == address(0)) revert ZeroAddress();
        if (tokenAmount == 0) revert AmountZero();

        uint256 fee = (tokenAmount * settlementFeeBps) / BPS_DENOMINATOR;

        token.safeTransferFrom(msg.sender, receiver, tokenAmount);
        if (fee > 0) {
            token.safeTransferFrom(msg.sender, address(this), fee);
            _distributeFees(fee);
        }

        // Cross-VPP transfers do not adjust totalVerifiedEnergyInStorage by
        // themselves — the energy delivery (or lack thereof) is reported by
        // the providing VPP via settleEnergy on its own side. This contract
        // only routes tokens.

        emit CrossVPPSettled(msg.sender, receiver, counterpartyVPPId, tokenAmount, fee);
    }

    // ---------------------------------------------------------------------
    // Minting fee skim — called by MintingEngine
    // ---------------------------------------------------------------------

    /// @inheritdoc ISettlement
    function collectMintingFee(
        address mintRecipient,
        uint256 grossMintedAmount
    ) external override whenNotPaused returns (uint256 feeTaken) {
        if (msg.sender != address(mintingEngine)) revert NotMintingEngine();
        if (grossMintedAmount == 0) return 0;

        feeTaken = (grossMintedAmount * mintingFeeBps) / BPS_DENOMINATOR;
        if (feeTaken == 0) return 0;

        token.safeTransferFrom(mintRecipient, address(this), feeTaken);
        _distributeFees(feeTaken);
    }

    // ---------------------------------------------------------------------
    // Admin
    // ---------------------------------------------------------------------

    /// @inheritdoc ISettlement
    function setFeeRecipients(FeeRecipients calldata recipients_) external override onlyRole(FEE_MANAGER_ROLE) {
        if (
            recipients_.treasury == address(0) ||
            recipients_.team == address(0) ||
            recipients_.ecosystem == address(0) ||
            recipients_.insurance == address(0)
        ) revert ZeroAddress();
        _recipients = recipients_;
        emit FeeRecipientsUpdated(recipients_);
    }

    /// @inheritdoc ISettlement
    function setSettlementFeeBps(uint256 newBps) external override onlyRole(FEE_MANAGER_ROLE) {
        if (newBps > MAX_FEE_BPS) revert FeeBpsTooHigh(newBps);
        settlementFeeBps = newBps;
        emit SettlementFeeBpsUpdated(newBps);
    }

    /// @inheritdoc ISettlement
    function setMintingFeeBps(uint256 newBps) external override onlyRole(FEE_MANAGER_ROLE) {
        if (newBps > MAX_FEE_BPS) revert FeeBpsTooHigh(newBps);
        mintingFeeBps = newBps;
        emit MintingFeeBpsUpdated(newBps);
    }

    function pause() external onlyRole(PAUSER_ROLE) {
        _pause();
    }

    function unpause() external onlyRole(PAUSER_ROLE) {
        _unpause();
    }

    // ---------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------

    /// @inheritdoc ISettlement
    function feeRecipients() external view override returns (FeeRecipients memory) {
        return _recipients;
    }

    // ---------------------------------------------------------------------
    // Internals
    // ---------------------------------------------------------------------

    /**
     * @dev Distribute a collected fee per the constant share table.
     *      Insurance gets the rounding remainder so the sum is always exact.
     */
    function _distributeFees(uint256 feeAmount) internal {
        uint256 toTreasury = (feeAmount * TREASURY_SHARE_BPS) / BPS_DENOMINATOR;
        uint256 toTeam = (feeAmount * TEAM_SHARE_BPS) / BPS_DENOMINATOR;
        uint256 toEcosystem = (feeAmount * ECOSYSTEM_SHARE_BPS) / BPS_DENOMINATOR;
        uint256 toInsurance = feeAmount - toTreasury - toTeam - toEcosystem;

        FeeRecipients memory r = _recipients;
        if (toTreasury > 0) token.safeTransfer(r.treasury, toTreasury);
        if (toTeam > 0) token.safeTransfer(r.team, toTeam);
        if (toEcosystem > 0) token.safeTransfer(r.ecosystem, toEcosystem);
        if (toInsurance > 0) token.safeTransfer(r.insurance, toInsurance);

        emit FeesDistributed(toTreasury, toTeam, toEcosystem, toInsurance);
    }

    // ---------------------------------------------------------------------
    // UUPS
    // ---------------------------------------------------------------------

    function _authorizeUpgrade(address newImplementation) internal override onlyRole(UPGRADER_ROLE) {}
}
