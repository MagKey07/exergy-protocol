/**
 * @file consensus.ts
 * @description Simulates a Chainlink decentralised oracle network: 5 nodes
 *              run the DSO cross-check independently, and at least 3 must
 *              agree before the adapter relays the packet on chain.
 *
 * In production: 5 actual Chainlink nodes pull the packet from the VPP cloud,
 * each queries the DSO API independently, and the median acceptance is
 * aggregated by the Chainlink Aggregator contract. We're mocking the network
 * by running 5 independent DSO checks in-process — each with its own RNG slice.
 *
 * Thresholds (constants — DO NOT make mutable):
 *   - 5 simulated nodes per packet
 *   - 3 acceptance votes required
 *   - 20% DSO discrepancy threshold per node (in dso-mock.ts)
 *
 * If <3 nodes accept, the packet is REJECTED — no relayer call, no on-chain
 * mint. There is no admin override. The only path to acceptance is for the
 * physical reading to be honest enough that 3+ independent DSO queries agree
 * within 20%.
 */
import {
  CONSENSUS_NODE_COUNT,
  CONSENSUS_THRESHOLD,
  type ConsensusResult,
  type DsoNodeCheck,
  type MeasurementPacket,
} from './types';
import { dsoCheck } from './dso-mock';
import { child } from './logger';

const log = child('consensus');

/**
 * Run 3-of-5 consensus.
 *
 * @param packet      Packet under review (already passed off-chain dual-sig
 *                    verification — verifier.ts gates the entry to this stage).
 * @param noiseRange  Forwarded to dso-mock per node.
 * @param randomFn    Optional RNG (default Math.random). Injectable for tests.
 */
export function runConsensus(
  packet: MeasurementPacket,
  noiseRange: readonly [number, number],
  randomFn: () => number = Math.random,
): ConsensusResult {
  const nodes: DsoNodeCheck[] = [];
  for (let i = 0; i < CONSENSUS_NODE_COUNT; i++) {
    nodes.push(dsoCheck(packet, noiseRange, `node-${i}`, randomFn));
  }
  const acceptCount = nodes.filter((n) => n.accepted).length;
  const rejectCount = nodes.length - acceptCount;
  const accepted = acceptCount >= CONSENSUS_THRESHOLD;

  if (!accepted) {
    const reason = `consensus failed: only ${acceptCount}/${CONSENSUS_NODE_COUNT} nodes accepted (threshold=${CONSENSUS_THRESHOLD})`;
    log.warn('reject', {
      deviceId: packet.deviceId,
      acceptCount,
      rejectCount,
      maxBps: Math.max(...nodes.map((n) => n.discrepancyBps)),
    });
    return { accepted: false, acceptCount, rejectCount, nodes, reason };
  }

  log.debug('accept', {
    deviceId: packet.deviceId,
    acceptCount,
    rejectCount,
    maxBps: Math.max(...nodes.map((n) => n.discrepancyBps)),
  });
  return { accepted: true, acceptCount, rejectCount, nodes };
}
