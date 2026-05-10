/**
 * Exergy VPP Connector SDK — Phase 0 (Arbitrum Sepolia testnet).
 *
 * Public API surface for VPP cloud operators integrating their existing
 * battery telemetry stream against the Exergy Protocol.
 *
 * See VPP_INTEGRATION_GUIDE.md in this repo for end-to-end docs.
 *
 * Quick mint:
 *
 *   import { signPacket, submitMeasurement, ARBITRUM_SEPOLIA, kwhToWad, SourceType } from "@exergy/vpp-connector-sdk";
 *
 *   const packet = {
 *     deviceId: ethers.id("vpp:my-network:device:0001"),
 *     kwhAmount: kwhToWad(5.2),
 *     timestamp: BigInt(Math.floor(Date.now() / 1000)),
 *     storageCapacity: kwhToWad(13.5),
 *     chargeLevelPercent: 87,
 *     sourceType: SourceType.Solar,
 *     cumulativeCycles: 142,
 *   };
 *
 *   const signed = await signPacket({ packet, deviceWallet, vppCloudWallet });
 *
 *   const result = await submitMeasurement({
 *     packet,
 *     signed,
 *     oracleRouterAddress: ARBITRUM_SEPOLIA.contracts.oracleRouter,
 *     signer: vppCloudWallet,
 *   });
 */

export {
  buildPacketHash,
  kwhToWad,
  kwhToWadFromString,
  PACKET_TUPLE,
  SourceType,
} from "./packet";
export type { MeasurementPacket } from "./packet";

export {
  buildVppDigest,
  devicePubKeyHashFor,
  signPacket,
} from "./signing";
export type { SignedPacket, SignPacketArgs } from "./signing";

export {
  DEFAULT_SUBMIT_GAS_LIMIT,
  simulateSubmitMeasurement,
  submitMeasurement,
} from "./submitter";
export type {
  SubmitMeasurementArgs,
  SubmitMeasurementResult,
} from "./submitter";

export {
  ARBITRUM_SEPOLIA,
  deploymentForChain,
} from "./addresses";
export type { NetworkDeployment } from "./addresses";

export {
  MINTING_ENGINE_ABI,
  ORACLE_ROUTER_ABI,
  SETTLEMENT_ABI,
  XRGY_TOKEN_ABI,
} from "./abi";
