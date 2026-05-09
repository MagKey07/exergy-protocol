/**
 * @file oracle-router.abi.ts
 * @description Minimal ABI for OracleRouter functions the adapter calls.
 *
 * Mirror of `oracle-simulator/src/oracle-router.abi.ts` (same submission
 * shape — tuple form). Kept independent so the two services can evolve their
 * client subset without coupling.
 *
 * The contract committed to the tuple form (see `OracleRouter.sol`); we
 * declare only that overload to surface ABI drift loudly via ethers
 * "function not found" errors.
 */
export const ORACLE_ROUTER_ABI = [
  // Tuple submission — what OracleRouter.sol exposes.
  'function submitMeasurement((bytes32,uint256,uint64,uint256,uint8,uint8,uint32) packet, bytes deviceSig, bytes vppSig) external',
  // Read-only view used by health endpoint.
  'function CHAINLINK_RELAYER_ROLE() view returns (bytes32)',
  'function hasRole(bytes32 role, address account) view returns (bool)',
  // Events.
  'event MeasurementVerified(bytes32 indexed deviceId, address indexed vppAddress, uint256 kwhAmount, uint64 timestamp, uint256 epoch)',
] as const;
