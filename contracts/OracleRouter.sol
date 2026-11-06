// SPDX-License-Identifier: BUSL-1.1
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

    /// @notice deviceId → registered energy source + 1 (0 = not bound yet).
    /// @dev Appended in the source-check upgrade; takes one slot from `__gap`.
    mapping(bytes32 => uint8) private _deviceSourcePlusOne;

    /// @notice Source code for energy charged from the public grid at the participant's own
    ///         cost (decided 04.11.2026). It is new energy for the network, paid for, so it
    ///         mints like own generation, and only above the battery's high-water mark.
    ///         It is accepted on any device whatever source the device is bound to: one
    ///         battery may charge from its panels and from the grid.
    uint8 public constant SOURCE_GRID = 4;

    /// @notice Energy sources whose stored energy may mint notes. A list, not code:
    ///         adding a new source (e.g. green hydrogen) is one admin call, not a redeploy.
    /// @dev Appended in the source-check upgrade; takes one slot from `__gap`.
    mapping(uint8 => bool) private _allowedSource;

    /// @notice Notes are minted only inside a community of at least this many independent
    ///         participants (decided 04.11.2026). A lone battery stores, reports and lifts its
    ///         high-water mark, but mints nothing.
    uint256 public constant MIN_INDEPENDENT_PARTICIPANTS = 2;

    /// @notice deviceId → metering point at the grid operator (hashed id, e.g. a German MaLo).
    ///         Independent = own metering point: all batteries behind one point are one participant.
    /// @dev Appended in the independence upgrade; with the two mappings below takes three slots from `__gap`.
    mapping(bytes32 => bytes32) private _deviceMeteringPoint;

    /// @notice vpp → metering point → active devices behind it.
    mapping(address => mapping(bytes32 => uint256)) private _activeDevicesAtPoint;

    /// @notice vpp → number of distinct metering points with at least one active device.
    mapping(address => uint256) private _independentParticipants;

    /// @dev Reserved storage gap for upgradeable layout safety.
    uint256[35] private __gap;

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
        if (rec.active != active) {
            bytes32 point = _deviceMeteringPoint[deviceId];
            if (active) _addToPoint(rec.vppAddress, point);
            else _removeFromPoint(rec.vppAddress, point);
        }
        rec.active = active;
        emit DeviceActiveStatusChanged(deviceId, active);
    }

    /// @notice Place a device behind its metering point at the grid operator. Today Key Energy
    ///         sets it by hand from the grid-operator registration; on mainnet an independent
    ///         verifier signs it as part of admission by community vote (MAINNET_HARDENING E.1).
    function setDeviceMeteringPoint(bytes32 deviceId, bytes32 meteringPoint) external onlyRole(DEVICE_REGISTRAR_ROLE) {
        DeviceRecord storage rec = _devices[deviceId];
        if (rec.vppAddress == address(0)) revert DeviceNotRegistered(deviceId);
        bytes32 old = _deviceMeteringPoint[deviceId];
        if (old == meteringPoint) return;
        if (rec.active) {
            _removeFromPoint(rec.vppAddress, old);
            _addToPoint(rec.vppAddress, meteringPoint);
        }
        _deviceMeteringPoint[deviceId] = meteringPoint;
        emit DeviceMeteringPointSet(deviceId, meteringPoint);
    }

    function _addToPoint(address vpp, bytes32 point) private {
        if (point == bytes32(0)) return;
        if (_activeDevicesAtPoint[vpp][point]++ == 0) _independentParticipants[vpp]++;
    }

    function _removeFromPoint(address vpp, bytes32 point) private {
        if (point == bytes32(0)) return;
        if (--_activeDevicesAtPoint[vpp][point] == 0) _independentParticipants[vpp]--;
    }

    /// @notice Bind a device to its energy source. Once bound, packets carrying new
    ///         energy must report the same source.
    function setDeviceSource(bytes32 deviceId, uint8 sourceType) external onlyRole(DEVICE_REGISTRAR_ROLE) {
        if (_devices[deviceId].vppAddress == address(0)) revert DeviceNotRegistered(deviceId);
        _deviceSourcePlusOne[deviceId] = sourceType + 1;
        emit DeviceSourceSet(deviceId, sourceType);
    }

    /// @notice Add or remove an energy source from the list whose stored energy may mint.
    ///         Grid power is SOURCE_GRID (4); "other" (3) stays off the list. Which sources
    ///         mint is the list the connected communities will vote on.
    function setAllowedSource(uint8 sourceType, bool allowed) external onlyRole(DEFAULT_ADMIN_ROLE) {
        _allowedSource[sourceType] = allowed;
        emit AllowedSourceSet(sourceType, allowed);
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
    /// @dev Kept for the deployed adapters and simulators: the VPP signature binds no
    ///      statement about energy from other participants, so it is read as "none".
    ///      MAINNET BLOCKER (MAINNET_HARDENING E.1): remove, so every packet carries the
    ///      community's attestation.
    function submitMeasurement(
        MeasurementPacket calldata packet,
        bytes calldata deviceSignature,
        bytes calldata vppSignature
    ) external override whenNotPaused onlyRole(CHAINLINK_RELAYER_ROLE) {
        bytes32 packetHash = keccak256(abi.encode(packet));
        _submit(packet, packetHash, 0, deviceSignature, keccak256(abi.encode(packetHash, deviceSignature)), vppSignature);
    }

    /// @inheritdoc IOracleRouter
    function submitMeasurementWithOrigin(
        MeasurementPacket calldata packet,
        uint256 kwhFromMembers,
        bytes calldata deviceSignature,
        bytes calldata vppSignature
    ) external override whenNotPaused onlyRole(CHAINLINK_RELAYER_ROLE) {
        bytes32 packetHash = keccak256(abi.encode(packet));
        _submit(
            packet,
            packetHash,
            kwhFromMembers,
            deviceSignature,
            keccak256(abi.encode(packetHash, deviceSignature, kwhFromMembers)),
            vppSignature
        );
    }

    function _submit(
        MeasurementPacket calldata packet,
        bytes32 packetHash,
        uint256 kwhFromMembers,
        bytes calldata deviceSignature,
        bytes32 vppPayloadHash,
        bytes calldata vppSignature
    ) private {
        if (kwhFromMembers > packet.kwhAmount) revert MembersEnergyExceedsCharge(kwhFromMembers, packet.kwhAmount);
        DeviceRecord memory rec = _devices[packet.deviceId];
        if (rec.vppAddress == address(0)) revert DeviceNotRegistered(packet.deviceId);
        if (!rec.active) revert DeviceInactive(packet.deviceId);

        // Source check — only for packets that carry NEW energy (they mint). A pure
        // state-of-charge report must always get through, or a battery on a source
        // later taken off the list could never report its discharge.
        if (packet.kwhAmount > 0) {
            if (!_allowedSource[packet.sourceType]) revert SourceNotAllowed(packet.sourceType);
            uint8 bound = _deviceSourcePlusOne[packet.deviceId];
            if (bound != 0 && packet.sourceType != bound - 1 && packet.sourceType != SOURCE_GRID) {
                revert SourceMismatch(packet.deviceId, bound - 1, packet.sourceType);
            }
        }

        // Time window check.
        if (packet.timestamp > block.timestamp + MAX_FUTURE_DRIFT_SECONDS) revert TimestampOutOfWindow();
        if (block.timestamp > packet.timestamp + MAX_BACKDATE_SECONDS) revert TimestampOutOfWindow();

        // Replay protection.
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
        // VPP cloud signs the (packet, deviceSignature[, kwhFromMembers]) tuple — this binds
        // the VPP attestation to the specific device signature it validated.
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
        // Origin rules (decided 04.11.2026): energy from other participants mints nothing,
        // and nothing mints while the community has fewer than two independent participants.
        // A device not yet placed behind a metering point is not a counted participant either.
        bool communityTooSmall = _deviceMeteringPoint[packet.deviceId] == bytes32(0)
            || _independentParticipants[rec.vppAddress] < MIN_INDEPENDENT_PARTICIPANTS;
        uint256 kwhNotMinting = communityTooSmall ? packet.kwhAmount : kwhFromMembers;
        if (kwhNotMinting > 0) emit EnergyNotMinting(packet.deviceId, rec.vppAddress, kwhNotMinting, communityTooSmall);

        uint256 epoch = mintingEngine.currentEpoch();
        mintingEngine.commitVerifiedEnergyWithOrigin(
            packet.deviceId,
            rec.vppAddress,
            packet.kwhAmount,
            kwhNotMinting,
            packet.cumulativeCycles,
            packet.storageCapacity,
            packet.chargeLevelPercent
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

    /// @notice The source a device is bound to; `bound` is false until `setDeviceSource`.
    function deviceSource(bytes32 deviceId) external view returns (bool bound, uint8 sourceType) {
        uint8 v = _deviceSourcePlusOne[deviceId];
        return (v != 0, v == 0 ? 0 : v - 1);
    }

    /// @notice The metering point a device sits behind (0 = not set yet).
    function deviceMeteringPoint(bytes32 deviceId) external view returns (bytes32) {
        return _deviceMeteringPoint[deviceId];
    }

    /// @notice Independent participants (distinct metering points with an active device) of a VPP.
    function independentParticipants(address vppAddress) external view returns (uint256) {
        return _independentParticipants[vppAddress];
    }

    /// @notice Whether stored energy from this source may mint notes.
    function isSourceAllowed(uint8 sourceType) external view returns (bool) {
        return _allowedSource[sourceType];
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
