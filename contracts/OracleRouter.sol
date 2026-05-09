// SPDX-License-Identifier: MIT
// WARNING: MVP testnet implementation. Production deployment requires security audit by OpenZeppelin or Trail of Bits.
pragma solidity ^0.8.24;

import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {AccessControlUpgradeable} from "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import {PausableUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";

import {IOracleRouter} from "./interfaces/IOracleRouter.sol";
import {IMintingEngine} from "./interfaces/IMintingEngine.sol";

/**
 * @title OracleRouter
 * @author Exergy Protocol
 * @notice Trust boundary that turns off-chain measurements into mint events.
 *
 * @dev Anti-Simulation Lock — every measurement requires TWO signatures:
 *
 *   1) `deviceSignature` from the device's secp256k1 key.
 *      The recovered address's keccak256 hash MUST equal the registry's
 *      `devicePubKeyHash` for `packet.deviceId`.
 *      (We hash the address to keep the registry small and to allow rotation
 *       of pubkeys without leaking them on-chain.)
 *
 *   2) `vppSignature` from the VPP cloud's secp256k1 key.
 *      The signature is over keccak256(abi.encode(packetHash, deviceSignature)),
 *      i.e. the VPP cloud explicitly co-signs the device's payload. The
 *      recovered address MUST equal the `vppAddress` registered for the device.
 *
 * Single-sig / mismatched-sig packets revert. There is no admin override.
 *
 * @dev V1 Chainlink layer (additive — see docs/PROTOCOL_SPEC.md §V1):
 *      `submitMeasurement` is also gated to `CHAINLINK_RELAYER_ROLE`. The
 *      Chainlink External Adapter (running off-chain) holds this role and is
 *      the only address allowed to relay packets on-chain. This is ADDITIVE
 *      security — defence-in-depth — not a replacement for the dual-signature
 *      check, which still runs on every submission. The adapter is one
 *      implementation of the protocol; per CORE_THESIS "no centralized
 *      software gatekeeping", anyone can run their own adapter and apply for
 *      this role through governance (see PROTOCOL_SPEC.md §V1).
 *
 * MVP scope: Chainlink External Adapter / DSO cross-validation is mocked
 * (see chainlink-adapter/). Phase 1 swaps the mock for the real Chainlink
 * Aggregator address transparently — same role, different implementation.
 */
contract OracleRouter is
    IOracleRouter,
    Initializable,
    UUPSUpgradeable,
    AccessControlUpgradeable,
    PausableUpgradeable
{
    using ECDSA for bytes32;
    using MessageHashUtils for bytes32;

    // ---------------------------------------------------------------------
    // Roles
    // ---------------------------------------------------------------------

    bytes32 public constant UPGRADER_ROLE = keccak256("UPGRADER_ROLE");
    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");
    bytes32 public constant DEVICE_REGISTRAR_ROLE = keccak256("DEVICE_REGISTRAR_ROLE");
    /// @notice Single-address binding for the Chainlink External Adapter that
    /// is allowed to relay verified packets on-chain. See V1 in PROTOCOL_SPEC.md.
    bytes32 public constant CHAINLINK_RELAYER_ROLE = keccak256("CHAINLINK_RELAYER_ROLE");

    // ---------------------------------------------------------------------
    // Constants
    // ---------------------------------------------------------------------

    /// @notice Reject measurements with timestamp older than this many seconds (72h grace).
    uint256 public constant MAX_BACKDATE_SECONDS = 72 hours;
    /// @notice Reject measurements with timestamp this many seconds ahead of block.timestamp (clock skew tolerance).
    uint256 public constant MAX_FUTURE_DRIFT_SECONDS = 5 minutes;

    // ---------------------------------------------------------------------
    // Storage
    // ---------------------------------------------------------------------

    IMintingEngine public mintingEngine;

    /// @notice deviceId → device record.
    mapping(bytes32 => DeviceRecord) private _devices;

    /// @notice Replay protection — once a packet hash is consumed it cannot be reused.
    mapping(bytes32 => bool) private _processed;

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
        __Pausable_init();

        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(UPGRADER_ROLE, admin);
        _grantRole(PAUSER_ROLE, admin);
        _grantRole(DEVICE_REGISTRAR_ROLE, admin);
        // Bootstrap relayer = admin so existing deploy scripts, integration
        // tests, and the V0 oracle-simulator (direct-submit mode) keep working
        // out-of-the-box. Production deployments MUST grant CHAINLINK_RELAYER_ROLE
        // to the Chainlink External Adapter address only and renounce the
        // admin's relayer role through a TimelockController. See
        // MAINNET_HARDENING.md.
        _grantRole(CHAINLINK_RELAYER_ROLE, admin);
        emit ChainlinkRelayerSet(admin);
    }

    // ---------------------------------------------------------------------
    // Wiring
    // ---------------------------------------------------------------------

    /// @inheritdoc IOracleRouter
    function setMintingEngine(address engine) external override onlyRole(DEFAULT_ADMIN_ROLE) {
        if (engine == address(0)) revert ZeroAddress();
        if (address(mintingEngine) != address(0)) revert MintingEngineAlreadySet();
        mintingEngine = IMintingEngine(engine);
        emit MintingEngineSet(engine);
    }

    /// @inheritdoc IOracleRouter
    /// @dev Single-address binding semantics: granting CHAINLINK_RELAYER_ROLE to
    ///      a new address is the canonical way to migrate from the bootstrap
    ///      relayer (testnet admin) to the production Chainlink Aggregator
    ///      address. This function does NOT revoke the previous holder — admin
    ///      must call AccessControl.revokeRole separately so the migration is
    ///      explicit and visible. On mainnet, this MUST be timelocked per
    ///      MAINNET_HARDENING.md (testnet acceptable as direct admin call).
    function setRelayer(address relayer) external override onlyRole(DEFAULT_ADMIN_ROLE) {
        if (relayer == address(0)) revert ZeroAddress();
        _grantRole(CHAINLINK_RELAYER_ROLE, relayer);
        emit ChainlinkRelayerSet(relayer);
    }

    // ---------------------------------------------------------------------
    // Device registry
    // ---------------------------------------------------------------------

    /// @inheritdoc IOracleRouter
    function registerDevice(
        bytes32 deviceId,
        address vppAddress,
        bytes32 devicePubKeyHash
    ) external override onlyRole(DEVICE_REGISTRAR_ROLE) {
        if (vppAddress == address(0)) revert ZeroAddress();
        if (_devices[deviceId].vppAddress != address(0)) revert DeviceAlreadyRegistered(deviceId);
        _devices[deviceId] = DeviceRecord({
            vppAddress: vppAddress,
            devicePubKeyHash: devicePubKeyHash,
            active: true
        });
        emit DeviceRegistered(deviceId, vppAddress, devicePubKeyHash);
    }

    /// @inheritdoc IOracleRouter
    function setDeviceActive(bytes32 deviceId, bool active) external override onlyRole(DEVICE_REGISTRAR_ROLE) {
        DeviceRecord storage rec = _devices[deviceId];
        if (rec.vppAddress == address(0)) revert DeviceNotRegistered(deviceId);
        rec.active = active;
        emit DeviceActiveStatusChanged(deviceId, active);
    }

    // ---------------------------------------------------------------------
    // Submission
    // ---------------------------------------------------------------------

    /// @inheritdoc IOracleRouter
    /// @dev Gated to CHAINLINK_RELAYER_ROLE on top of the dual-signature check.
    ///      Defence-in-depth: the relayer (Chainlink External Adapter) has
    ///      already verified the dual signatures off-chain and run the 3-of-5
    ///      consensus + DSO cross-check, but the contract REPEATS the
    ///      signature verification anyway. The role gate is additive security,
    ///      not a replacement; if this role were granted to an attacker, they
    ///      could only pass through packets that are ALREADY validly dual-signed
    ///      by registered devices and VPPs.
    function submitMeasurement(
        MeasurementPacket calldata packet,
        bytes calldata deviceSignature,
        bytes calldata vppSignature
    ) external override whenNotPaused onlyRole(CHAINLINK_RELAYER_ROLE) {
        DeviceRecord memory rec = _devices[packet.deviceId];
        if (rec.vppAddress == address(0)) revert DeviceNotRegistered(packet.deviceId);
        if (!rec.active) revert DeviceInactive(packet.deviceId);

        // Time window check.
        if (packet.timestamp > block.timestamp + MAX_FUTURE_DRIFT_SECONDS) revert TimestampOutOfWindow();
        if (block.timestamp > packet.timestamp + MAX_BACKDATE_SECONDS) revert TimestampOutOfWindow();

        // Replay protection.
        bytes32 packetHash = keccak256(abi.encode(packet));
        if (_processed[packetHash]) revert DuplicateMeasurement(packetHash);

        // ---- Device signature verification ----
        // We sign the EIP-191 prefixed hash so that off-chain signers can use
        // standard `personal_sign` semantics. Production may move to EIP-712.
        bytes32 deviceDigest = packetHash.toEthSignedMessageHash();
        address recoveredDevice = deviceDigest.recover(deviceSignature);
        if (keccak256(abi.encodePacked(recoveredDevice)) != rec.devicePubKeyHash) {
            revert InvalidDeviceSignature();
        }

        // ---- VPP cloud signature verification ----
        // VPP cloud signs the (packet, deviceSignature) tuple — this binds the
        // VPP attestation to the specific device signature it validated.
        bytes32 vppPayloadHash = keccak256(abi.encode(packetHash, deviceSignature));
        bytes32 vppDigest = vppPayloadHash.toEthSignedMessageHash();
        address recoveredVPP = vppDigest.recover(vppSignature);
        if (recoveredVPP != rec.vppAddress) revert InvalidVPPSignature();

        // Mark consumed BEFORE external call (CEI).
        _processed[packetHash] = true;

        // Forward to MintingEngine. Engine returns minted amount (used for analytics only here).
        // Pass `cumulativeCycles` and `storageCapacity` through so the engine can run its
        // autonomous Proof-of-Wear check (Blueprint §5.6). Anomaly LOGIC lives in the
        // engine — not here — per CONCEPT_AUDIT D-7. This router does NOT short-circuit
        // those checks; it just shuttles the signed packet fields through.
        uint256 epoch = mintingEngine.currentEpoch();
        mintingEngine.commitVerifiedEnergy(
            packet.deviceId,
            rec.vppAddress,
            packet.kwhAmount,
            packet.cumulativeCycles,
            packet.storageCapacity
        );

        emit MeasurementVerified(packet.deviceId, rec.vppAddress, packet.kwhAmount, packet.timestamp, epoch);
    }

    // ---------------------------------------------------------------------
    // Pause
    // ---------------------------------------------------------------------

    function pause() external onlyRole(PAUSER_ROLE) {
        _pause();
    }

    function unpause() external onlyRole(PAUSER_ROLE) {
        _unpause();
    }

    // ---------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------

    /// @inheritdoc IOracleRouter
    function getDevice(bytes32 deviceId) external view override returns (DeviceRecord memory) {
        return _devices[deviceId];
    }

    /// @inheritdoc IOracleRouter
    function isMeasurementProcessed(bytes32 packetHash) external view override returns (bool) {
        return _processed[packetHash];
    }

    // ---------------------------------------------------------------------
    // UUPS
    // ---------------------------------------------------------------------

    function _authorizeUpgrade(address newImplementation) internal override onlyRole(UPGRADER_ROLE) {}
}
