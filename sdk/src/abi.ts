/**
 * Minimal ABI surface that a VPP integrator needs at runtime.
 *
 * Kept narrow on purpose — only the functions and events you call or
 * subscribe to. The full ABI is in `MVP/contracts/artifacts/` after
 * compilation if you need more.
 */

export const ORACLE_ROUTER_ABI = [
  // Hot path
  "function submitMeasurement(tuple(bytes32 deviceId, uint256 kwhAmount, uint64 timestamp, uint256 storageCapacity, uint8 chargeLevelPercent, uint8 sourceType, uint32 cumulativeCycles) packet, bytes deviceSignature, bytes vppSignature) external",

  // Pre-flight checks
  "function isMeasurementProcessed(bytes32 packetHash) external view returns (bool)",
  "function getDevice(bytes32 deviceId) external view returns (tuple(address vppAddress, bytes32 devicePubKeyHash, bool active))",
  "function hasRole(bytes32 role, address account) external view returns (bool)",
  "function paused() external view returns (bool)",

  // Events you'll want to index
  "event MeasurementVerified(bytes32 indexed deviceId, address indexed vppAddress, uint256 kwhAmount, uint64 timestamp, uint256 epoch)",
  "event DeviceRegistered(bytes32 indexed deviceId, address indexed vppAddress, bytes32 devicePubKeyHash)",
  "event DeviceActiveStatusChanged(bytes32 indexed deviceId, bool active)",
] as const;

export const MINTING_ENGINE_ABI = [
  // View functions for monitoring + pre-flight checks
  "function currentEra() external view returns (uint256)",
  "function currentMintRateWeiPerKwh() external view returns (uint256)",
  "function getFloatingIndex() external view returns (uint256)",
  "function currentEpoch() external view returns (uint256)",
  "function totalVerifiedEnergyInStorage() external view returns (uint256)",
  "function totalTokensMinted() external view returns (uint256)",
  "function halvingThreshold() external view returns (uint256)",
  "function genesisTimestamp() external view returns (uint256)",
  "function getDeviceCycleState(bytes32 deviceId) external view returns (tuple(uint32 lastCumulativeCycles, uint64 lastEpoch, uint256 storageCapacity, bool initialized))",
  "function getEpochData(uint256 epoch) external view returns (tuple(uint256 totalVerifiedKwh, uint256 totalTokensMinted, bytes32 merkleRoot, bool sealed_))",

  // Events
  "event EnergyMinted(bytes32 indexed deviceId, address indexed vppAddress, uint256 kwhAmount, uint256 tokensMinted, uint256 indexed epoch, uint256 era)",
  "event HalvingTriggered(uint256 indexed newEra, uint256 newRateNumerator, uint256 totalSupplyAtHalving)",
  "event AnomalyRejected(bytes32 indexed deviceId, address indexed vppAddress, uint256 kwhAmount, uint32 cumulativeCycles, bytes32 reason)",
  "event EpochSealed(uint256 indexed epoch)",
] as const;

export const XRGY_TOKEN_ABI = [
  // Standard ERC-20
  "function balanceOf(address account) external view returns (uint256)",
  "function totalSupply() external view returns (uint256)",
  "function decimals() external view returns (uint8)",
  "function symbol() external view returns (string)",
  "function transfer(address to, uint256 amount) external returns (bool)",
  "function approve(address spender, uint256 amount) external returns (bool)",
  "function allowance(address owner, address spender) external view returns (uint256)",

  // EIP-2612 permit
  "function permit(address owner, address spender, uint256 value, uint256 deadline, uint8 v, bytes32 r, bytes32 s) external",
  "function nonces(address owner) external view returns (uint256)",
  "function DOMAIN_SEPARATOR() external view returns (bytes32)",

  "event Transfer(address indexed from, address indexed to, uint256 value)",
  "event Approval(address indexed owner, address indexed spender, uint256 value)",
] as const;

export const SETTLEMENT_ABI = [
  "function mintingFeeBps() external view returns (uint16)",
  "function settlementFeeBps() external view returns (uint16)",
  "function settleEnergy(address provider, uint256 tokenAmount, uint256 kwhConsumed) external",
  "function crossVPPSettle(address receiver, bytes32 counterpartyVPPId, uint256 tokenAmount) external",

  "event MintingFeeCollected(address indexed mintRecipient, uint256 grossAmount, uint256 feeAmount)",
  "event Settled(address indexed payer, address indexed provider, uint256 tokenAmount, uint256 kwhConsumed, uint256 fee)",
] as const;
