/**
 * @file oracle-router.abi.ts
 * @description Minimal ABI for OracleRouter functions the simulator calls.
 *
 * The smart-contracts agent owns the canonical ABI. This subset is what we
 * need from the off-chain side. Function signatures must match the deployed
 * contract; if they drift, ethers will fail with "function not found" at
 * runtime — easy to spot, no silent corruption.
 *
 * Two submission shapes are supported so the off-chain side does not have to
 * change when the contract author picks one:
 *
 *   1. submitMeasurement(struct MeasurementPacket, bytes deviceSig, bytes vppSig)
 *   2. submitMeasurement(bytes32 deviceId, uint256 kwhAmount, uint64 timestamp,
 *        uint256 storageCapacity, uint8 chargeLevelPercent, uint8 sourceType,
 *        uint32 cumulativeCycles, bytes deviceSig, bytes vppSig)
 *
 * The submitter probes the deployed contract to discover which is live.
 */

export const ORACLE_ROUTER_ABI = [
  // Tuple form
  'function submitMeasurement((bytes32,uint256,uint64,uint256,uint8,uint8,uint32) packet, bytes deviceSig, bytes vppSig) external',
  // Flat form
  'function submitMeasurement(bytes32 deviceId, uint256 kwhAmount, uint64 timestamp, uint256 storageCapacity, uint8 chargeLevelPercent, uint8 sourceType, uint32 cumulativeCycles, bytes deviceSig, bytes vppSig) external',
  // Device registry — owner-only, called by `register-device` CLI command
  'function registerDevice(bytes32 deviceId, address vpp, bytes32 pubKeyHash) external',
  'function deregisterDevice(bytes32 deviceId) external',
  // Read-only helpers (used for sanity checks before submit)
  'function deviceToVpp(bytes32 deviceId) external view returns (address)',
  'function devicePubKeyHash(bytes32 deviceId) external view returns (bytes32)',
  // Events — best-effort log parsing in the submitter
  'event MeasurementAccepted(bytes32 indexed deviceId, address indexed vpp, uint256 kwhAmount, uint64 timestamp)',
  'event MeasurementRejected(bytes32 indexed deviceId, string reason)',
  'event DeviceRegistered(bytes32 indexed deviceId, address indexed vpp, bytes32 pubKeyHash)',
] as const;
