// SPDX-License-Identifier: MIT
// WARNING: MVP testnet implementation. Production deployment requires security audit by OpenZeppelin or Trail of Bits.
pragma solidity ^0.8.24;

/**
 * @title IOracleRouter
 * @notice Trust boundary between off-chain measurements and on-chain minting.
 *
 * Verification rules (Anti-Simulation Lock):
 *  - Each MeasurementPacket MUST be signed twice — once by the device's
 *    secp256k1 key (HSM-backed in production) and once by the VPP cloud's
 *    secp256k1 key. Single-sig packets are REJECTED at the contract level.
 *  - device_id must be registered. The recovered device address must match
 *    the registry entry; the VPP cloud signature must come from the VPP
 *    address bound to that device.
 *
 * MVP scope: Chainlink External Adapter / DSO cross-validation is mocked.
 * Phase 1 swaps in real Chainlink + DSO. The interface stays the same so
 * the MintingEngine sees no change.
 */
interface IOracleRouter {
    /**
     * @notice The off-chain measurement payload signed by device + VPP cloud.
     * @dev `kwhAmount` is integer kWh (no decimals). `cumulativeCycles` is
     *      Proof-of-Wear — anomalous values trigger oracle-level rejection.
     */
    struct MeasurementPacket {
        bytes32 deviceId;
        uint256 kwhAmount;
        uint64 timestamp;
        uint256 storageCapacity;
        uint8 chargeLevelPercent;
        uint8 sourceType; // 0=solar, 1=wind, 2=hydro, 3=other
        uint32 cumulativeCycles;
    }

    /**
     * @notice Device registration entry.
     * @param vppAddress Cloud-signer VPP that owns this device.
     * @param devicePubKeyHash keccak256 of the device's secp256k1 public key.
     * @param active Whether the device is allowed to submit measurements.
     */
    struct DeviceRecord {
        address vppAddress;
        bytes32 devicePubKeyHash;
        bool active;
    }

    /// @notice A new device was registered.
    event DeviceRegistered(bytes32 indexed deviceId, address indexed vppAddress, bytes32 devicePubKeyHash);
    /// @notice A device's active flag changed.
    event DeviceActiveStatusChanged(bytes32 indexed deviceId, bool active);
    /// @notice A measurement passed dual-signature verification and was forwarded to MintingEngine.
    event MeasurementVerified(
        bytes32 indexed deviceId,
        address indexed vppAddress,
        uint256 kwhAmount,
        uint64 timestamp,
        uint256 epoch
    );
    /// @notice The MintingEngine address bound to this router.
    event MintingEngineSet(address indexed mintingEngine);
    /// @notice The CHAINLINK_RELAYER_ROLE was granted to a new relayer
    /// (typically the deployed Chainlink External Adapter address).
    event ChainlinkRelayerSet(address indexed relayer);

    /// @notice Caller is not allowed to register devices.
    error NotDeviceRegistrar();
    /// @notice Caller is not the registered Chainlink relayer.
    error NotChainlinkRelayer();
    /// @notice Device id is already registered.
    error DeviceAlreadyRegistered(bytes32 deviceId);
    /// @notice Device id is not registered.
    error DeviceNotRegistered(bytes32 deviceId);
    /// @notice Device is registered but currently deactivated.
    error DeviceInactive(bytes32 deviceId);
    /// @notice Device signature does not match the registered device key hash.
    error InvalidDeviceSignature();
    /// @notice VPP signature does not match the VPP bound to this device.
    error InvalidVPPSignature();
    /// @notice Submitted timestamp is in the future or older than the grace window.
    error TimestampOutOfWindow();
    /// @notice Submitted measurement was already processed (replay protection).
    error DuplicateMeasurement(bytes32 packetHash);
    /// @notice Provided address is the zero address.
    error ZeroAddress();
    /// @notice MintingEngine has already been set.
    error MintingEngineAlreadySet();

    /**
     * @notice Submit a verified measurement to be forwarded to the MintingEngine.
     * @dev Reverts unless BOTH device and VPP signatures recover to the registered keys.
     * @param packet The off-chain measurement payload.
     * @param deviceSignature Device-side ECDSA signature over keccak256(abi.encode(packet)).
     * @param vppSignature VPP-cloud ECDSA signature over keccak256(abi.encode(packet, deviceSignature)).
     */
    function submitMeasurement(
        MeasurementPacket calldata packet,
        bytes calldata deviceSignature,
        bytes calldata vppSignature
    ) external;

    /// @notice Register a new device. Restricted to DEVICE_REGISTRAR_ROLE.
    function registerDevice(bytes32 deviceId, address vppAddress, bytes32 devicePubKeyHash) external;

    /// @notice Activate / deactivate a previously registered device.
    function setDeviceActive(bytes32 deviceId, bool active) external;

    /// @notice One-time wiring of the MintingEngine address.
    function setMintingEngine(address mintingEngine) external;

    /// @notice Grant CHAINLINK_RELAYER_ROLE to a new relayer (e.g. a freshly
    /// deployed Chainlink External Adapter). Admin-only. Production deploys
    /// must route this through the same TimelockController as UPGRADER_ROLE
    /// (see MAINNET_HARDENING.md).
    function setRelayer(address relayer) external;

    /// @notice Lookup a registered device record.
    function getDevice(bytes32 deviceId) external view returns (DeviceRecord memory);

    /// @notice Returns true if a packet hash has already been consumed.
    function isMeasurementProcessed(bytes32 packetHash) external view returns (bool);
}
