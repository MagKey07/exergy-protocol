// SPDX-License-Identifier: BUSL-1.1
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
 * Fee semantics:
 *  - Settlement fee: 0.25% (25 bps) of each settle, paid by the payer ON TOP of
 *    the principal, 100% to the Key Energy treasury. So
 *    `settleEnergy(provider, A, k)` requires the payer to have approved
 *    `A + A*0.25%` to Settlement. The rate can only move inside the
 *    constitutional corridor 0.1–0.5% (10–50 bps).
 *  - Mint shares (Key Energy treasury, insurance reserve) are taken inside
 *    MintingEngine at mint time; this contract only supplies the recipient
 *    addresses via feeRecipients(). Fees are charged only here, at settlement —
 *    never on plain token transfers.
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
    /// @notice May place participants into VPP perimeters (Phase 0: admin; Phase 1: VPP operators).
    bytes32 public constant PERIMETER_MANAGER_ROLE = keccak256("PERIMETER_MANAGER_ROLE");

    /// @notice Constitutional corridor for the settlement fee.
    uint256 public constant MIN_SETTLEMENT_FEE_BPS = 10; // 0.1%
    uint256 public constant MAX_SETTLEMENT_FEE_BPS = 50; // 0.5%
    uint256 public constant BPS_DENOMINATOR = 10_000;

    /// @notice Energy for a note settles at the floating index: notes = kWh ÷ index.
    ///         Tolerance covers the index moving between quote and inclusion.
    uint256 public constant INDEX_RATE_TOLERANCE_BPS = 100; // 1%

    // ---------------------------------------------------------------------
    // Storage
    // ---------------------------------------------------------------------

    IERC20 public token;
    IMintingEngine public mintingEngine;

    uint256 public override settlementFeeBps; // default 25 (=0.25%)
    /// @dev Former minting-fee rate; unused since mint shares became constants in
    ///      MintingEngine (18.10.2026). Kept only to preserve the storage layout.
    /// @custom:oz-renamed-from mintingFeeBps
    uint256 private _unusedMintingFeeBps;

    FeeRecipients private _recipients;

    /// @dev Reserved storage gap for upgradeable layout safety.
    uint256[40] private __gap;

    /// @dev participant => VPP perimeter id. Appended after the gap so the
    ///      existing proxy layout is untouched on upgrade.
    mapping(address => bytes32) private _participantVPP;

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

        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(UPGRADER_ROLE, admin);
        _grantRole(PAUSER_ROLE, admin);
        _grantRole(FEE_MANAGER_ROLE, admin);

        emit FeeRecipientsUpdated(recipients_);
        emit SettlementFeeBpsUpdated(25);
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

        // Energy for a note travels over a wire, so it can only happen inside
        // one VPP. The note itself may travel anywhere (crossVPPSettle).
        bytes32 payerVPP = _participantVPP[msg.sender];
        if (payerVPP == bytes32(0) || payerVPP != _participantVPP[provider]) {
            revert OutsidePerimeter(msg.sender, provider);
        }

        // A neighbour gives the kWh written on the note: the exchange rate is the
        // note's own energy content at the moment of the deal, set by the protocol,
        // not negotiated. notes = kWh / floatingIndex (both 18-decimal).
        if (kwhConsumed == 0) revert KwhRequired();
        uint256 index = mintingEngine.getFloatingIndex();
        if (index == 0) revert NoEnergyBehindNotes();
        uint256 atIndex = (kwhConsumed * 1e18) / index;
        uint256 band = (atIndex * INDEX_RATE_TOLERANCE_BPS) / BPS_DENOMINATOR;
        if (tokenAmount + band < atIndex || tokenAmount > atIndex + band) {
            revert OffIndexRate(tokenAmount, atIndex);
        }

        uint256 fee = (tokenAmount * settlementFeeBps) / BPS_DENOMINATOR;

        // Pull principal → provider. (NO burn; this is a transfer.)
        token.safeTransferFrom(msg.sender, provider, tokenAmount);

        // Fee → Key Energy treasury.
        if (fee > 0) _payFee(fee);

        // Report the consumption (the pool itself follows the next charge-level report).
        mintingEngine.recordEnergyConsumption(kwhConsumed);

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
        if (fee > 0) _payFee(fee);

        // Cross-VPP transfers do not adjust totalVerifiedEnergyInStorage by
        // themselves — the energy delivery (or lack thereof) is reported by
        // the providing VPP via settleEnergy on its own side. This contract
        // only routes tokens.

        emit CrossVPPSettled(msg.sender, receiver, counterpartyVPPId, tokenAmount, fee);
    }

    // ---------------------------------------------------------------------
    // VPP perimeter
    // ---------------------------------------------------------------------

    /// @inheritdoc ISettlement
    function setParticipantVPP(address participant, bytes32 vppId) external override {
        if (!hasRole(PERIMETER_MANAGER_ROLE, msg.sender) && !hasRole(DEFAULT_ADMIN_ROLE, msg.sender)) {
            revert NotPerimeterManager();
        }
        if (participant == address(0)) revert ZeroAddress();
        _participantVPP[participant] = vppId;
        emit ParticipantVPPSet(participant, vppId);
    }

    /// @inheritdoc ISettlement
    function participantVPP(address participant) external view override returns (bytes32) {
        return _participantVPP[participant];
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
        if (newBps < MIN_SETTLEMENT_FEE_BPS || newBps > MAX_SETTLEMENT_FEE_BPS) {
            revert SettlementFeeOutOfCorridor(newBps);
        }
        settlementFeeBps = newBps;
        emit SettlementFeeBpsUpdated(newBps);
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

    /// @dev Pull the settlement fee from the payer straight to the Key Energy treasury.
    function _payFee(uint256 feeAmount) internal {
        address treasury = _recipients.treasury;
        token.safeTransferFrom(msg.sender, treasury, feeAmount);
        emit SettlementFeePaid(treasury, feeAmount);
    }

    // ---------------------------------------------------------------------
    // UUPS
    // ---------------------------------------------------------------------

    function _authorizeUpgrade(address newImplementation) internal override onlyRole(UPGRADER_ROLE) {}
}
