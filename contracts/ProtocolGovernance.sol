// SPDX-License-Identifier: MIT
// WARNING: MVP testnet implementation. Production deployment requires security audit by OpenZeppelin or Trail of Bits.
pragma solidity ^0.8.24;

import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {AccessControlUpgradeable} from "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import {Ownable2StepUpgradeable} from "@openzeppelin/contracts-upgradeable/access/Ownable2StepUpgradeable.sol";
import {PausableUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";

import {IProtocolGovernance} from "./interfaces/IProtocolGovernance.sol";

/**
 * @title ProtocolGovernance
 * @author Exergy Protocol
 * @notice Admin / governance hub for the Exergy testnet MVP.
 *
 * @dev Responsibilities (per Technical_Blueprint §2.5):
 *  - VPP registration / deactivation.
 *  - Emergency pause flag (read by other contracts on demand).
 *  - Two-step ownership transfer.
 *  - UUPS upgrade authority over its own implementation.
 *  - Holds a registry of managed contracts (engine / router / settlement / token)
 *    keyed by `keccak256("ENGINE")` etc., so admin tooling has a single source
 *    of truth for protocol addresses.
 *
 * MVP simplifications vs production:
 *  - No 48h timelock. Single GOVERNOR_ROLE acts immediately. Production swaps
 *    GOVERNOR_ROLE membership to a TimelockController.
 *  - Pause flag here is informational; each module enforces its own pause.
 *    Modules can subscribe to this flag in a future revision (or be paused
 *    individually by the same admin).
 */
contract ProtocolGovernance is
    IProtocolGovernance,
    Initializable,
    UUPSUpgradeable,
    AccessControlUpgradeable,
    Ownable2StepUpgradeable,
    PausableUpgradeable
{
    // ---------------------------------------------------------------------
    // Roles
    // ---------------------------------------------------------------------

    bytes32 public constant UPGRADER_ROLE = keccak256("UPGRADER_ROLE");
    bytes32 public constant GOVERNOR_ROLE = keccak256("GOVERNOR_ROLE");
    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");

    // Standard managed contract keys (publish for off-chain tooling).
    bytes32 public constant KEY_TOKEN = keccak256("TOKEN");
    bytes32 public constant KEY_ENGINE = keccak256("ENGINE");
    bytes32 public constant KEY_ROUTER = keccak256("ROUTER");
    bytes32 public constant KEY_SETTLEMENT = keccak256("SETTLEMENT");

    // ---------------------------------------------------------------------
    // Storage
    // ---------------------------------------------------------------------

    mapping(bytes32 => VPPRecord) private _vpps;
    mapping(address => bool) private _isActiveVPPOperator;
    mapping(bytes32 => address) private _managedContracts;

    /// @dev Reserved storage gap for upgradeable layout safety.
    uint256[40] private __gap;

    // ---------------------------------------------------------------------
    // Initializer
    // ---------------------------------------------------------------------

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(address admin) external initializer {
        if (admin == address(0)) revert ZeroAddress();

        __UUPSUpgradeable_init();
        __AccessControl_init();
        __Ownable_init(admin);
        __Ownable2Step_init();
        __Pausable_init();

        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(UPGRADER_ROLE, admin);
        _grantRole(GOVERNOR_ROLE, admin);
        _grantRole(PAUSER_ROLE, admin);
    }

    // ---------------------------------------------------------------------
    // VPP registry
    // ---------------------------------------------------------------------

    /// @inheritdoc IProtocolGovernance
    function registerVPP(bytes32 vppId, address operatorAddress) external override onlyRole(GOVERNOR_ROLE) {
        if (operatorAddress == address(0)) revert ZeroAddress();
        if (_vpps[vppId].operatorAddress != address(0)) revert VPPAlreadyRegistered(vppId);
        _vpps[vppId] = VPPRecord({
            vppId: vppId,
            operatorAddress: operatorAddress,
            active: true,
            registeredAt: uint64(block.timestamp)
        });
        _isActiveVPPOperator[operatorAddress] = true;
        emit VPPRegistered(vppId, operatorAddress);
    }

    /// @inheritdoc IProtocolGovernance
    function setVPPActive(bytes32 vppId, bool active) external override onlyRole(GOVERNOR_ROLE) {
        VPPRecord storage rec = _vpps[vppId];
        if (rec.operatorAddress == address(0)) revert VPPNotRegistered(vppId);
        rec.active = active;
        _isActiveVPPOperator[rec.operatorAddress] = active;
        emit VPPActiveStatusChanged(vppId, active);
    }

    // ---------------------------------------------------------------------
    // Pause flag (informational; modules enforce their own)
    // ---------------------------------------------------------------------

    /// @inheritdoc IProtocolGovernance
    function pauseProtocol() external override onlyRole(PAUSER_ROLE) {
        _pause();
        emit ProtocolPauseToggled(true);
    }

    /// @inheritdoc IProtocolGovernance
    function unpauseProtocol() external override onlyRole(GOVERNOR_ROLE) {
        _unpause();
        emit ProtocolPauseToggled(false);
    }

    // ---------------------------------------------------------------------
    // Managed contracts registry
    // ---------------------------------------------------------------------

    /// @inheritdoc IProtocolGovernance
    function setManagedContract(bytes32 key, address addr) external override onlyRole(GOVERNOR_ROLE) {
        if (addr == address(0)) revert ZeroAddress();
        _managedContracts[key] = addr;
        emit ManagedContractSet(key, addr);
    }

    // ---------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------

    /// @inheritdoc IProtocolGovernance
    function getVPP(bytes32 vppId) external view override returns (VPPRecord memory) {
        return _vpps[vppId];
    }

    /// @inheritdoc IProtocolGovernance
    function isActiveVPPOperator(address addr) external view override returns (bool) {
        return _isActiveVPPOperator[addr];
    }

    /// @inheritdoc IProtocolGovernance
    function getManagedContract(bytes32 key) external view override returns (address) {
        return _managedContracts[key];
    }

    // ---------------------------------------------------------------------
    // Ownership / Upgrade plumbing
    // ---------------------------------------------------------------------

    /**
     * @dev Two-step ownership transfer is provided by Ownable2StepUpgradeable.
     *      Override `_transferOwnership` to also keep DEFAULT_ADMIN_ROLE in sync.
     */
    function _transferOwnership(address newOwner) internal override {
        address oldOwner = owner();
        super._transferOwnership(newOwner);
        if (oldOwner != address(0) && oldOwner != newOwner) {
            _revokeRole(DEFAULT_ADMIN_ROLE, oldOwner);
        }
        if (newOwner != address(0)) {
            _grantRole(DEFAULT_ADMIN_ROLE, newOwner);
        }
    }

    function _authorizeUpgrade(address newImplementation) internal override onlyRole(UPGRADER_ROLE) {}
}
