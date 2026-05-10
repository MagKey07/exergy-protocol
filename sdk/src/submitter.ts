import {
  Contract,
  Signer,
  TransactionReceipt,
  TransactionResponse,
} from "ethers";

import { ORACLE_ROUTER_ABI } from "./abi";
import { MeasurementPacket } from "./packet";
import { SignedPacket } from "./signing";

/**
 * Recommended gas limit for `submitMeasurement`.
 *
 * MintingEngine wraps `Settlement.collectMintingFee` in a Solidity
 * try/catch. EIP-150 forwards only 63/64 of remaining gas to the inner
 * call, so a tight outer estimate makes the inner call OOG-revert
 * silently — your mint succeeds but the 1% fee is never collected.
 *
 * 600,000 is comfortably above the worst-case observed gas usage
 * (~430k) on Arbitrum Sepolia. Adjust upward if you start hitting
 * out-of-gas errors for the outer call (extremely rare).
 */
export const DEFAULT_SUBMIT_GAS_LIMIT = 600_000n;

export interface SubmitMeasurementArgs {
  packet: MeasurementPacket;
  signed: SignedPacket;
  oracleRouterAddress: string;
  signer: Signer;
  gasLimit?: bigint;
}

export interface SubmitMeasurementResult {
  txHash: string;
  blockNumber: number;
  gasUsed: bigint;
  receipt: TransactionReceipt;
}

/**
 * Submit a dual-signed packet to OracleRouter. The caller (signer) must
 * hold `CHAINLINK_RELAYER_ROLE` on the OracleRouter contract — this is
 * granted by the protocol admin during onboarding (see
 * VPP_INTEGRATION_GUIDE.md §4 step 1).
 */
export async function submitMeasurement(
  args: SubmitMeasurementArgs,
): Promise<SubmitMeasurementResult> {
  const router = new Contract(
    args.oracleRouterAddress,
    ORACLE_ROUTER_ABI,
    args.signer,
  );

  const packetTuple = [
    args.packet.deviceId,
    args.packet.kwhAmount,
    args.packet.timestamp,
    args.packet.storageCapacity,
    args.packet.chargeLevelPercent,
    args.packet.sourceType,
    args.packet.cumulativeCycles,
  ];

  const tx: TransactionResponse = await router.submitMeasurement(
    packetTuple,
    args.signed.deviceSignature,
    args.signed.vppSignature,
    { gasLimit: args.gasLimit ?? DEFAULT_SUBMIT_GAS_LIMIT },
  );

  const receipt = await tx.wait();
  if (!receipt) {
    throw new Error("Transaction submitted but no receipt returned");
  }

  return {
    txHash: tx.hash,
    blockNumber: receipt.blockNumber,
    gasUsed: receipt.gasUsed,
    receipt,
  };
}

/**
 * Pre-flight check: simulate the submit call without sending. Useful for
 * catching `InvalidDeviceSignature`, `ProofOfWearViolation`, etc. before
 * burning gas on a doomed transaction.
 *
 * Returns null on success, or the revert reason string on failure.
 */
export async function simulateSubmitMeasurement(
  args: SubmitMeasurementArgs,
): Promise<string | null> {
  const router = new Contract(
    args.oracleRouterAddress,
    ORACLE_ROUTER_ABI,
    args.signer,
  );
  const packetTuple = [
    args.packet.deviceId,
    args.packet.kwhAmount,
    args.packet.timestamp,
    args.packet.storageCapacity,
    args.packet.chargeLevelPercent,
    args.packet.sourceType,
    args.packet.cumulativeCycles,
  ];
  try {
    await router.submitMeasurement.staticCall(
      packetTuple,
      args.signed.deviceSignature,
      args.signed.vppSignature,
    );
    return null;
  } catch (err) {
    const e = err as { shortMessage?: string; reason?: string; message?: string };
    return e.shortMessage ?? e.reason ?? e.message ?? "unknown revert";
  }
}
